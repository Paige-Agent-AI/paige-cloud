BEGIN;

-- The provisioner creates paige_cloud_account_runtime as a non-login role.
-- Only the trusted identity service's database login receives that role.
CREATE SCHEMA cloud_accounts;
REVOKE ALL ON SCHEMA cloud_accounts FROM PUBLIC;

CREATE TABLE cloud_accounts.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY
    (START WITH 100000000000 MAXVALUE 999999999999) UNIQUE,
  identity_issuer text NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 512),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name text CHECK (length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE cloud_accounts.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL UNIQUE REFERENCES cloud_accounts.accounts(id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_accounts.memberships (
  organization_id uuid NOT NULL REFERENCES cloud_accounts.organizations(id),
  account_id uuid NOT NULL REFERENCES cloud_accounts.accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, account_id)
);

CREATE INDEX memberships_by_account ON cloud_accounts.memberships(account_id)
  WHERE revoked_at IS NULL;

-- The caller takes issuer, subject and email from a verified identity, never request JSON.
CREATE FUNCTION cloud_accounts.record_verified_identity(
  issuer text, subject text, verified_email text
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO cloud_accounts.accounts (identity_issuer, identity_subject, email)
  VALUES (issuer, subject, verified_email)
  ON CONFLICT (identity_issuer, identity_subject) DO UPDATE SET email = EXCLUDED.email
  RETURNING id
$$;

CREATE FUNCTION cloud_accounts.find_verified_identity(issuer text, subject text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT id FROM cloud_accounts.accounts
  WHERE identity_issuer = issuer AND identity_subject = subject
$$;

CREATE FUNCTION cloud_accounts.account_details(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'number', a.number::text,
    'email', a.email,
    'displayName', a.display_name,
    'organizations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role)
                       ORDER BY o.created_at, o.id)
      FROM cloud_accounts.memberships AS m
      JOIN cloud_accounts.organizations AS o ON o.id = m.organization_id
      WHERE m.account_id = a.id AND m.revoked_at IS NULL
    ), '[]'::jsonb)
  )
  FROM cloud_accounts.accounts AS a WHERE a.id = actor
$$;

CREATE FUNCTION cloud_accounts.organization_details(actor uuid, organization uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role)
  FROM cloud_accounts.memberships AS m
  JOIN cloud_accounts.organizations AS o ON o.id = m.organization_id
  WHERE m.account_id = actor AND m.organization_id = organization AND m.revoked_at IS NULL
$$;

-- Account onboarding creates exactly one initial organization. An interrupted response is
-- recovered by retrying the same name. A retry cannot reinstate a revoked membership.
CREATE FUNCTION cloud_accounts.onboard_organization(actor uuid, requested_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  organization uuid;
  original_name text;
BEGIN
  requested_name := btrim(requested_name);
  IF requested_name IS NULL OR length(requested_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'An organization name is required';
  END IF;

  INSERT INTO cloud_accounts.organizations (created_by, name)
  VALUES (actor, requested_name)
  ON CONFLICT (created_by) DO NOTHING
  RETURNING id INTO organization;

  IF organization IS NOT NULL THEN
    INSERT INTO cloud_accounts.memberships (organization_id, account_id, role)
    VALUES (organization, actor, 'owner');
  ELSE
    SELECT id, name INTO STRICT organization, original_name
    FROM cloud_accounts.organizations WHERE created_by = actor;
    IF cloud_accounts.organization_details(actor, organization) IS NULL THEN
      RETURN NULL;
    END IF;
    IF original_name <> requested_name THEN
      RETURN jsonb_build_object('error', 'organization_exists');
    END IF;
  END IF;

  RETURN cloud_accounts.organization_details(actor, organization);
END
$$;

CREATE FUNCTION cloud_accounts.update_display_name(actor uuid, requested_name text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE cloud_accounts.accounts
  SET display_name = NULLIF(btrim(requested_name), '')
  WHERE id = actor
  RETURNING jsonb_build_object('number', number::text, 'email', email, 'displayName', display_name)
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cloud_accounts FROM PUBLIC;
GRANT USAGE ON SCHEMA cloud_accounts TO paige_cloud_account_runtime;
GRANT EXECUTE ON FUNCTION
  cloud_accounts.record_verified_identity(text, text, text),
  cloud_accounts.find_verified_identity(text, text),
  cloud_accounts.account_details(uuid),
  cloud_accounts.organization_details(uuid, uuid),
  cloud_accounts.onboard_organization(uuid, text),
  cloud_accounts.update_display_name(uuid, text)
TO paige_cloud_account_runtime;

COMMIT;
