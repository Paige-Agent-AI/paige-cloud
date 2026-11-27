BEGIN;

CREATE FUNCTION cloud_accounts.rename_organization(actor uuid, organization uuid, expected_name text, requested_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE original_name text;
BEGIN
  requested_name := btrim(requested_name);
  IF requested_name IS NULL OR length(requested_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'An organization name is required';
  END IF;

  PERFORM 1 FROM cloud_accounts.memberships m
    WHERE m.organization_id = organization AND m.account_id = actor
      AND m.role = 'owner' AND m.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT o.name INTO STRICT original_name FROM cloud_accounts.organizations o
    WHERE o.id = organization FOR UPDATE;
  IF original_name <> requested_name THEN
    IF original_name IS DISTINCT FROM expected_name THEN
      RETURN jsonb_build_object('error', 'organization_changed');
    END IF;
    UPDATE cloud_accounts.organizations SET name = requested_name WHERE id = organization;
  END IF;
  RETURN cloud_accounts.organization_details(actor, organization);
END;
$$;

REVOKE EXECUTE ON FUNCTION cloud_accounts.rename_organization(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.rename_organization(uuid, uuid, text, text) TO paige_cloud_account_runtime;

COMMIT;
