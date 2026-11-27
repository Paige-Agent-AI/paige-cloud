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
     OR jsonb_array_length(cloud_accounts.registry_list_applications(actor, org, 'workspace')) <> 2
     OR cloud_accounts.registry_list_applications(other_actor, other_org, 'workspace') IS DISTINCT FROM '[]'::jsonb
     OR cloud_accounts.registry_list_applications(other_actor, org, 'workspace') IS NOT NULL
     OR cloud_accounts.registry_list_applications(member, org, 'workspace') IS NOT NULL
     OR cloud_accounts.registry_register_application(other_actor, org, 'workspace', 'app', 'Foreign', 'service', NULL, 'preview') IS NOT NULL THEN
    RAISE EXCEPTION 'application collision or project membership isolation failed';
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
  IF jsonb_array_length(cloud_accounts.registry_list_applications(member, org, 'workspace')) IS DISTINCT FROM 2
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
  IF cloud_accounts.registry_list_applications(current_setting('paige.registry.member')::uuid,
     current_setting('paige.registry.org')::uuid, 'workspace') IS NOT NULL THEN
    RAISE EXCEPTION 'revoked organization membership left a project read active';
  END IF;
END
$$;
ROLLBACK;
