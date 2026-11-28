BEGIN;

CREATE TABLE cloud_accounts.repository_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  application_id text NOT NULL,
  environment_id text NOT NULL,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  repository text NOT NULL CHECK (repository ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}$'),
  ref text NOT NULL CHECK (ref ~ '^refs/heads/[A-Za-z0-9][A-Za-z0-9_/-]{0,119}$'
    AND ref !~ '//|/$|/-'),
  connection_arn text NOT NULL CHECK (connection_arn ~
    '^arn:aws:(codeconnections|codestar-connections):us-east-2:[0-9]{12}:connection/[a-f0-9-]{36}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz CHECK (revoked_at >= recorded_at),
  FOREIGN KEY (organization_id, project_id, application_id, environment_id) REFERENCES cloud_accounts.registry_targets
);

CREATE UNIQUE INDEX repository_bindings_one_current ON cloud_accounts.repository_bindings
  (organization_id, project_id, application_id, environment_id) WHERE revoked_at IS NULL;

REVOKE ALL ON cloud_accounts.repository_bindings FROM PUBLIC, paige_cloud_account_runtime;

CREATE FUNCTION cloud_accounts.read_repository_binding(actor uuid, org uuid, project text, app text, environment text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('binding', CASE WHEN b.id IS NOT NULL THEN jsonb_build_object(
    'repository', b.repository, 'repositoryId', b.repository_id, 'ref', b.ref, 'recordedAt', b.recorded_at
  ) END)
  FROM cloud_accounts.registry_targets t
  JOIN cloud_accounts.registry_grants g USING (organization_id, project_id)
  JOIN cloud_accounts.memberships m ON m.organization_id = g.organization_id AND m.account_id = g.account_id
  JOIN cloud_accounts.registry_applications a
    ON a.organization_id = t.organization_id AND a.project_id = t.project_id AND a.id = t.application_id
  LEFT JOIN cloud_accounts.repository_bindings b
    ON b.organization_id = t.organization_id AND b.project_id = t.project_id AND b.application_id = t.application_id
    AND b.environment_id = t.environment_id AND b.revoked_at IS NULL AND lower(b.repository) = lower(a.source_repository)
  WHERE t.organization_id = org AND t.project_id = project AND t.application_id = app
    AND t.environment_id = environment AND g.account_id = actor AND m.revoked_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION cloud_accounts.read_repository_binding(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.read_repository_binding(uuid, uuid, text, text, text) TO paige_cloud_account_runtime;

COMMIT;
