-- The preceding account test seeded and then revoked some memberships. Give
-- this scenario its own users and organizations in the disposable database.
BEGIN;
SELECT set_config('paige.registry.owner', cloud_accounts.record_verified_identity('registry', 'owner', 'owner@example.test')::text, true);
SELECT set_config('paige.registry.other', cloud_accounts.record_verified_identity('registry', 'other', 'other@example.test')::text, true);
SELECT set_config('paige.registry.member', cloud_accounts.record_verified_identity('registry', 'member', 'member@example.test')::text, true);
SELECT set_config('paige.registry.org', cloud_accounts.onboard_organization(current_setting('paige.registry.owner')::uuid, 'Registry Alpha')->>'id', true);
SELECT set_config('paige.registry.other_org', cloud_accounts.onboard_organization(current_setting('paige.registry.other')::uuid, 'Registry Beta')->>'id', true);
INSERT INTO cloud_accounts.memberships (organization_id, account_id, role)
VALUES (current_setting('paige.registry.org')::uuid, current_setting('paige.registry.member')::uuid, 'member');

SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  actor uuid := current_setting('paige.registry.owner')::uuid;
  other_actor uuid := current_setting('paige.registry.other')::uuid;
  member uuid := current_setting('paige.registry.member')::uuid;
  org uuid := current_setting('paige.registry.org')::uuid;
  other_org uuid := current_setting('paige.registry.other_org')::uuid;
BEGIN
  IF cloud_accounts.registry_list_projects(actor, org) IS DISTINCT FROM '[]'::jsonb
     OR cloud_accounts.registry_list_projects(actor, other_org) IS NOT NULL THEN
    RAISE EXCEPTION 'empty and foreign organization states were conflated';
  END IF;
  IF cloud_accounts.registry_create_project(actor, org, 'workspace', 'Workspace')->>'role' IS DISTINCT FROM 'owner'
     OR cloud_accounts.registry_create_project(other_actor, other_org, 'workspace', 'Workspace')->>'role' IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'independent project scopes did not permit each owner';
  END IF;
  IF cloud_accounts.registry_create_project(actor, org, 'workspace', 'Workspace')->>'id' IS DISTINCT FROM 'workspace'
     OR cloud_accounts.registry_create_project(actor, org, 'workspace', 'Other')->>'error' IS DISTINCT FROM 'registration_conflict'
     OR cloud_accounts.registry_create_project(member, org, 'another', 'Another') IS NOT NULL THEN
    RAISE EXCEPTION 'owner role or project replay was not enforced';
  END IF;
  IF cloud_accounts.registry_register_application(actor, org, 'workspace', 'customer-zero', 'Customer Zero', 'application', NULL, 'development')->>'id'
       IS DISTINCT FROM 'customer-zero'
     OR cloud_accounts.registry_register_application(actor, org, 'workspace', 'independent', 'Independent', 'application', 'example/source', 'development')->>'id'
       IS DISTINCT FROM 'independent'
     OR cloud_accounts.registry_register_application(actor, org, 'workspace', 'independent', 'Independent', 'application', 'example/source', 'preview')->'environments'
       IS DISTINCT FROM '["development", "preview"]'::jsonb THEN
    RAISE EXCEPTION 'applications and multiple environments did not retain stable scope';
  END IF;
  IF cloud_accounts.registry_register_application(actor, org, 'workspace', 'independent', 'Changed', 'service', NULL, 'preview')->>'error'
       IS DISTINCT FROM 'registration_conflict'
     OR (SELECT count(*) FROM cloud_accounts.registry_list_applications(actor, org, 'workspace')) <> 2
     OR (SELECT * FROM cloud_accounts.registry_list_applications(other_actor, other_org, 'workspace')) IS DISTINCT FROM ''
     OR (SELECT * FROM cloud_accounts.registry_list_applications(other_actor, org, 'workspace')) IS NOT NULL
     OR (SELECT * FROM cloud_accounts.registry_list_applications(member, org, 'workspace')) IS NOT NULL
     OR cloud_accounts.registry_register_application(other_actor, org, 'workspace', 'app', 'Foreign', 'service', NULL, 'preview') IS NOT NULL THEN
    RAISE EXCEPTION 'application collision or project membership isolation failed';
  END IF;
  IF cloud_accounts.reserve_workload_observation(other_actor, org, 'workspace', 'independent', 'development') IS NOT NULL
     OR cloud_accounts.reserve_workload_observation(actor, org, 'workspace', 'independent', 'missing') IS NOT NULL
     OR cloud_accounts.reserve_workload_observation(actor, org, 'workspace', 'independent', 'development') IS DISTINCT FROM 'reserved'
     OR cloud_accounts.reserve_workload_observation(actor, org, 'workspace', 'independent', 'development') IS DISTINCT FROM 'limited'
     OR has_table_privilege(current_user, 'cloud_accounts.workload_observation_budget', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'inspection scope, pacing or metering access failed';
  END IF;
END
$$;
RESET ROLE;

INSERT INTO cloud_accounts.repository_bindings (
  organization_id, project_id, application_id, environment_id, repository_id, repository, ref, connection_arn
) VALUES (
  current_setting('paige.registry.org')::uuid, 'workspace', 'independent', 'development',
  '1207965608', 'Example/Source', 'refs/heads/main',
  'arn:aws:codeconnections:us-east-2:111111111111:connection/11111111-1111-4111-8111-111111111111'
);

DO $$
BEGIN
  INSERT INTO cloud_accounts.repository_bindings (
    organization_id, project_id, application_id, environment_id, repository_id, repository, ref, connection_arn
  )
  SELECT organization_id, project_id, application_id, environment_id, '42', repository, ref, connection_arn
  FROM cloud_accounts.repository_bindings WHERE organization_id = current_setting('paige.registry.org')::uuid;
  RAISE EXCEPTION 'simultaneous repository bindings were accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END
$$;

SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  owner_id uuid := current_setting('paige.registry.owner')::uuid;
  other_id uuid := current_setting('paige.registry.other')::uuid;
  org uuid := current_setting('paige.registry.org')::uuid;
  binding jsonb;
BEGIN
  binding := cloud_accounts.read_repository_binding(owner_id, org, 'workspace', 'independent', 'development')->'binding';
  IF binding->>'repository' IS DISTINCT FROM 'Example/Source'
     OR binding->>'repositoryId' IS DISTINCT FROM '1207965608'
     OR binding->>'ref' IS DISTINCT FROM 'refs/heads/main'
     OR (binding - 'repository' - 'repositoryId' - 'ref' - 'recordedAt') IS DISTINCT FROM '{}'::jsonb
     OR binding->>'recordedAt' IS NULL
     OR cloud_accounts.read_repository_binding(owner_id, org, 'workspace', 'independent', 'preview')
        IS DISTINCT FROM '{"binding":null}'::jsonb
     OR cloud_accounts.read_repository_binding(owner_id, org, 'workspace', 'independent', 'missing') IS NOT NULL
     OR cloud_accounts.read_repository_binding(other_id, org, 'workspace', 'independent', 'development') IS NOT NULL
     OR has_table_privilege(current_user, 'cloud_accounts.repository_bindings',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'repository binding exposed unscoped, unverified or restricted fields';
  END IF;
END
$$;
RESET ROLE;

UPDATE cloud_accounts.repository_bindings SET revoked_at = clock_timestamp()
WHERE organization_id = current_setting('paige.registry.org')::uuid;

SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF cloud_accounts.read_repository_binding(current_setting('paige.registry.owner')::uuid,
    current_setting('paige.registry.org')::uuid, 'workspace', 'independent', 'development')
    IS DISTINCT FROM '{"binding":null}'::jsonb THEN
    RAISE EXCEPTION 'repository revocation did not clear the active binding';
  END IF;
END
$$;
RESET ROLE;

UPDATE cloud_accounts.workload_observation_budget SET attempts = 24, reserved_at = clock_timestamp() - interval '31 seconds'
WHERE organization_id = current_setting('paige.registry.org')::uuid;
SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF cloud_accounts.reserve_workload_observation(current_setting('paige.registry.owner')::uuid,
    current_setting('paige.registry.org')::uuid, 'workspace', 'independent', 'development') IS DISTINCT FROM 'limited' THEN
    RAISE EXCEPTION 'daily inspection limit did not hold';
  END IF;
END
$$;
RESET ROLE;

INSERT INTO cloud_accounts.registry_grants VALUES (
  current_setting('paige.registry.org')::uuid, 'workspace', current_setting('paige.registry.member')::uuid, 'member'
);
SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  member uuid := current_setting('paige.registry.member')::uuid;
  org uuid := current_setting('paige.registry.org')::uuid;
BEGIN
  IF (SELECT count(*) FROM cloud_accounts.registry_list_applications(member, org, 'workspace')) IS DISTINCT FROM 2::bigint
     OR cloud_accounts.registry_register_application(member, org, 'workspace', 'app', 'Denied', 'service', NULL, 'preview') IS NOT NULL THEN
    RAISE EXCEPTION 'project member read/write separation failed';
  END IF;
END
$$;
RESET ROLE;
UPDATE cloud_accounts.memberships SET revoked_at = now()
WHERE organization_id = current_setting('paige.registry.org')::uuid AND account_id = current_setting('paige.registry.member')::uuid;
SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF (SELECT * FROM cloud_accounts.registry_list_applications(current_setting('paige.registry.member')::uuid,
     current_setting('paige.registry.org')::uuid, 'workspace')) IS NOT NULL
     OR cloud_accounts.reserve_workload_observation(current_setting('paige.registry.member')::uuid,
     current_setting('paige.registry.org')::uuid, 'workspace', 'independent', 'development') IS NOT NULL THEN
    RAISE EXCEPTION 'revoked organization membership left a project read active';
  END IF;
END
$$;
RESET ROLE;

-- The complete result exceeds the Data API's per-row limit. Each application
-- still fits individually, and the aggregate stays below the response limit.
INSERT INTO cloud_accounts.registry_applications
SELECT current_setting('paige.registry.org')::uuid, 'workspace', 'app-' || n, 'Application ' || n, 'application', NULL
FROM generate_series(1, 98) n;
INSERT INTO cloud_accounts.registry_environments
SELECT current_setting('paige.registry.org')::uuid, 'workspace', repeat('e', 45) || lpad(n::text, 3, '0')
FROM generate_series(1, 48) n;
INSERT INTO cloud_accounts.registry_targets
SELECT a.organization_id, a.project_id, a.id, e.id FROM cloud_accounts.registry_applications a
JOIN cloud_accounts.registry_environments e USING (organization_id, project_id)
WHERE a.organization_id = current_setting('paige.registry.org')::uuid
ON CONFLICT DO NOTHING;
SET LOCAL ROLE paige_cloud_account_runtime;
DO $$
DECLARE row_count bigint; largest_row integer; result_bytes bigint;
BEGIN
  SELECT count(*), max(octet_length(value)), sum(octet_length(value)) INTO row_count, largest_row, result_bytes
  FROM cloud_accounts.registry_list_applications(current_setting('paige.registry.owner')::uuid,
       current_setting('paige.registry.org')::uuid, 'workspace') value;
  IF row_count <> 100 OR largest_row >= 65536 OR result_bytes NOT BETWEEN 65537 AND 900000 THEN
    RAISE EXCEPTION 'registry output is unsafe at configured capacity';
  END IF;
END
$$;
ROLLBACK;
