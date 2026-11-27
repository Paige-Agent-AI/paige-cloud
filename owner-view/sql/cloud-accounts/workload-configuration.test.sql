BEGIN;

SET ROLE paige_cloud_account_runtime;
SELECT set_config('test.config_owner', cloud_accounts.record_verified_identity('configuration-test', 'owner', 'owner@example.test')::text, true);
SELECT set_config('test.config_reader', cloud_accounts.record_verified_identity('configuration-test', 'reader', 'reader@example.test')::text, true);
SELECT set_config('test.config_other', cloud_accounts.record_verified_identity('configuration-test', 'other', 'other@example.test')::text, true);
SELECT set_config('test.config_org', cloud_accounts.onboard_organization(current_setting('test.config_owner')::uuid, 'Config A')->>'id', true);
SELECT set_config('test.config_other_org', cloud_accounts.onboard_organization(current_setting('test.config_other')::uuid, 'Config B')->>'id', true);
SELECT cloud_accounts.registry_create_project(current_setting('test.config_owner')::uuid, current_setting('test.config_org')::uuid, 'platform', 'Platform');
SELECT cloud_accounts.registry_create_project(current_setting('test.config_other')::uuid, current_setting('test.config_other_org')::uuid, 'platform', 'Platform');
SELECT cloud_accounts.registry_register_application(current_setting('test.config_owner')::uuid,
  current_setting('test.config_org')::uuid, 'platform', 'app', 'App', 'application', NULL, environment)
FROM (VALUES ('development'), ('preview')) targets(environment);
SELECT cloud_accounts.registry_register_application(current_setting('test.config_other')::uuid,
  current_setting('test.config_other_org')::uuid, 'platform', 'app', 'App', 'application', NULL, 'development');
RESET ROLE;

INSERT INTO cloud_accounts.memberships (organization_id, account_id, role)
VALUES (current_setting('test.config_org')::uuid, current_setting('test.config_reader')::uuid, 'member');
INSERT INTO cloud_accounts.registry_grants (organization_id, project_id, account_id, role)
VALUES (current_setting('test.config_org')::uuid, 'platform', current_setting('test.config_reader')::uuid, 'member');

SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  owner_id uuid := current_setting('test.config_owner')::uuid;
  reader_id uuid := current_setting('test.config_reader')::uuid;
  other_id uuid := current_setting('test.config_other')::uuid;
  org_id uuid := current_setting('test.config_org')::uuid;
  other_org_id uuid := current_setting('test.config_other_org')::uuid;
  saved jsonb;
BEGIN
  IF cloud_accounts.read_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', NULL)
       IS DISTINCT FROM '{"revision":0,"configuration":null}'::jsonb THEN
    RAISE EXCEPTION 'empty target did not return revision zero';
  END IF;

  saved := cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 0, 'warn', 2600);
  IF saved->>'revision' IS DISTINCT FROM '1' OR saved->'configuration' IS DISTINCT FROM '{"logLevel":"warn","requestTimeoutMs":2600}'::jsonb
     OR saved->>'savedAt' IS NULL THEN
    RAISE EXCEPTION 'initial save did not return the committed data';
  END IF;
  IF cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 0, 'warn', 2600)
       IS DISTINCT FROM saved OR cloud_accounts.read_workload_configuration(reader_id, org_id, 'platform', 'app', 'development', NULL)
       IS DISTINCT FROM saved THEN
    RAISE EXCEPTION 'replay or authorized reader did not resolve to the original revision';
  END IF;
  IF cloud_accounts.save_workload_configuration(reader_id, org_id, 'platform', 'app', 'development', 1, 'info', 900) IS NOT NULL
     OR cloud_accounts.read_workload_configuration(other_id, org_id, 'platform', 'app', 'development', NULL) IS NOT NULL
     OR cloud_accounts.save_workload_configuration(owner_id, other_org_id, 'platform', 'app', 'development', 0, 'warn', 200) IS NOT NULL
     OR cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'missing', 0, 'warn', 200) IS NOT NULL THEN
    RAISE EXCEPTION 'configuration crossed a role, tenant or registration boundary';
  END IF;
  IF cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 0, 'info', 2700)->>'error'
       IS DISTINCT FROM 'configuration_changed'
     OR cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 1, 'info', 99)->>'error'
       IS DISTINCT FROM 'invalid_configuration' THEN
    RAISE EXCEPTION 'stale or invalid write was admitted';
  END IF;
  IF cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 1, 'info', 2700)->>'revision'
       IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'second revision did not persist';
  END IF;
  IF cloud_accounts.read_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 1) IS DISTINCT FROM saved
     OR cloud_accounts.read_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 3) IS NOT NULL
     OR cloud_accounts.read_workload_configuration(owner_id, org_id, 'platform', 'app', 'preview', NULL)->>'revision' IS DISTINCT FROM '0'
     OR cloud_accounts.read_workload_configuration(other_id, other_org_id, 'platform', 'app', 'development', NULL)->>'revision' IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'revision or environment isolation failed';
  END IF;
  FOR revision IN 2..31 LOOP
    IF cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', revision, 'info', 2700 + revision)->>'revision'
         IS DISTINCT FROM (revision + 1)::text THEN
      RAISE EXCEPTION 'configuration revision fell below its bound';
    END IF;
  END LOOP;
  IF cloud_accounts.save_workload_configuration(owner_id, org_id, 'platform', 'app', 'development', 32, 'info', 8000)->>'error'
       IS DISTINCT FROM 'configuration_limit' THEN
    RAISE EXCEPTION 'revision ceiling was not enforced';
  END IF;
END
$$;
RESET ROLE;

UPDATE cloud_accounts.memberships SET revoked_at = now()
WHERE account_id = current_setting('test.config_owner')::uuid;
SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE actor_id uuid := current_setting('test.config_owner')::uuid;
  org_id uuid := current_setting('test.config_org')::uuid;
BEGIN
  IF cloud_accounts.read_workload_configuration(actor_id, org_id, 'platform', 'app', 'development', 1) IS NOT NULL
     OR cloud_accounts.save_workload_configuration(actor_id, org_id, 'platform', 'app', 'preview', 0, 'warn', 200) IS NOT NULL THEN
    RAISE EXCEPTION 'revoked owner retained configuration access';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;
