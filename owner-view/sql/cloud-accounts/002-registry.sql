BEGIN;

CREATE TABLE cloud_accounts.registry_projects (
  organization_id uuid NOT NULL REFERENCES cloud_accounts.organizations(id),
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE cloud_accounts.registry_grants (
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  account_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (organization_id, project_id, account_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES cloud_accounts.registry_projects,
  FOREIGN KEY (organization_id, account_id) REFERENCES cloud_accounts.memberships
);

CREATE TABLE cloud_accounts.registry_applications (
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('application', 'service')),
  source_repository text CHECK (source_repository ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}$'),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES cloud_accounts.registry_projects
);

CREATE TABLE cloud_accounts.registry_environments (
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES cloud_accounts.registry_projects
);

CREATE TABLE cloud_accounts.registry_targets (
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  application_id text NOT NULL,
  environment_id text NOT NULL,
  PRIMARY KEY (organization_id, project_id, application_id, environment_id),
  FOREIGN KEY (organization_id, project_id, application_id) REFERENCES cloud_accounts.registry_applications,
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES cloud_accounts.registry_environments
);

CREATE FUNCTION cloud_accounts.registry_list_projects(actor uuid, org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', g.role) ORDER BY p.id), '[]'::jsonb)
  FROM cloud_accounts.registry_projects p JOIN cloud_accounts.registry_grants g
    ON g.organization_id = p.organization_id AND g.project_id = p.id AND g.account_id = actor
  WHERE p.organization_id = org
  HAVING EXISTS (
    SELECT 1 FROM cloud_accounts.memberships m
    WHERE m.organization_id = org AND m.account_id = actor AND m.revoked_at IS NULL
  )
$$;

CREATE FUNCTION cloud_accounts.registry_create_project(actor uuid, org uuid, project text, display text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE existing_name text;
BEGIN
  PERFORM 1 FROM cloud_accounts.memberships m WHERE m.organization_id = org
    AND m.account_id = actor AND m.revoked_at IS NULL AND m.role = 'owner' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM cloud_accounts.organizations o WHERE o.id = org FOR UPDATE;

  SELECT p.name INTO existing_name FROM cloud_accounts.registry_projects p WHERE p.organization_id = org AND p.id = project;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM cloud_accounts.registry_grants g WHERE g.organization_id = org
      AND g.project_id = project AND g.account_id = actor AND g.role = 'owner') THEN RETURN NULL; END IF;
    IF existing_name <> display THEN RETURN jsonb_build_object('error', 'registration_conflict'); END IF;
  ELSE
    IF (SELECT count(*) FROM cloud_accounts.registry_projects p WHERE p.organization_id = org) >= 50 THEN
      RETURN jsonb_build_object('error', 'registry_limit');
    END IF;
    INSERT INTO cloud_accounts.registry_projects VALUES (org, project, display);
    INSERT INTO cloud_accounts.registry_grants VALUES (org, project, actor, 'owner');
  END IF;
  RETURN jsonb_build_object('id', project, 'name', display, 'role', 'owner');
END;
$$;

CREATE FUNCTION cloud_accounts.registry_list_applications(actor uuid, org uuid, project text) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH access AS (
    SELECT EXISTS (SELECT 1 FROM cloud_accounts.registry_grants g JOIN cloud_accounts.memberships m
      ON m.organization_id = g.organization_id AND m.account_id = g.account_id
    WHERE g.organization_id = org AND g.project_id = project AND g.account_id = actor AND m.revoked_at IS NULL
    ) AS permitted
  )
  -- A sentinel distinguishes denied from empty. Each application gets its own
  -- Data API row, including its targets, to stay within the per-row limit.
  SELECT CASE
    WHEN NOT access.permitted THEN NULL
    WHEN a.id IS NULL THEN ''
    ELSE jsonb_build_object(
      'id', a.id, 'name', a.name, 'kind', a.kind, 'sourceRepository', a.source_repository,
      'environments', (SELECT jsonb_agg(t.environment_id ORDER BY t.environment_id)
        FROM cloud_accounts.registry_targets t WHERE t.organization_id = org
          AND t.project_id = project AND t.application_id = a.id))::text
  END
  FROM access LEFT JOIN cloud_accounts.registry_applications a
    ON access.permitted AND a.organization_id = org AND a.project_id = project
  ORDER BY a.id
$$;

CREATE FUNCTION cloud_accounts.registry_register_application(
  actor uuid, org uuid, project text, app text, display text, app_kind text, repository text, environment text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE existing cloud_accounts.registry_applications%ROWTYPE;
BEGIN
  PERFORM 1 FROM cloud_accounts.registry_grants g JOIN cloud_accounts.memberships m
    ON m.organization_id = g.organization_id AND m.account_id = g.account_id
    WHERE g.organization_id = org AND g.project_id = project AND g.account_id = actor
      AND g.role = 'owner' AND m.revoked_at IS NULL FOR SHARE OF g, m;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM cloud_accounts.registry_projects p WHERE p.organization_id = org AND p.id = project FOR UPDATE;

  SELECT * INTO existing FROM cloud_accounts.registry_applications a
    WHERE a.organization_id = org AND a.project_id = project AND a.id = app;
  IF FOUND THEN
    IF (existing.name, existing.kind, existing.source_repository) IS DISTINCT FROM (display, app_kind, repository) THEN
      RETURN jsonb_build_object('error', 'registration_conflict');
    END IF;
  ELSIF (SELECT count(*) FROM cloud_accounts.registry_applications a
    WHERE a.organization_id = org AND a.project_id = project) >= 100 THEN
    RETURN jsonb_build_object('error', 'registry_limit');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cloud_accounts.registry_environments e
    WHERE e.organization_id = org AND e.project_id = project AND e.id = environment)
    AND (SELECT count(*) FROM cloud_accounts.registry_environments e
      WHERE e.organization_id = org AND e.project_id = project) >= 50 THEN
    RETURN jsonb_build_object('error', 'registry_limit');
  END IF;

  INSERT INTO cloud_accounts.registry_applications VALUES (org, project, app, display, app_kind, repository)
    ON CONFLICT DO NOTHING;
  INSERT INTO cloud_accounts.registry_environments VALUES (org, project, environment) ON CONFLICT DO NOTHING;
  INSERT INTO cloud_accounts.registry_targets VALUES (org, project, app, environment) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id', app, 'name', display, 'kind', app_kind, 'sourceRepository', repository,
    'environments', (SELECT jsonb_agg(t.environment_id ORDER BY t.environment_id)
      FROM cloud_accounts.registry_targets t WHERE t.organization_id = org
        AND t.project_id = project AND t.application_id = app));
END;
$$;

REVOKE EXECUTE ON FUNCTION cloud_accounts.registry_list_projects(uuid, uuid),
  cloud_accounts.registry_create_project(uuid, uuid, text, text),
  cloud_accounts.registry_list_applications(uuid, uuid, text),
  cloud_accounts.registry_register_application(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.registry_list_projects(uuid, uuid),
  cloud_accounts.registry_create_project(uuid, uuid, text, text),
  cloud_accounts.registry_list_applications(uuid, uuid, text),
  cloud_accounts.registry_register_application(uuid, uuid, text, text, text, text, text, text)
TO paige_cloud_account_runtime;

COMMIT;
