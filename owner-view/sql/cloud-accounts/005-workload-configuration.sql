BEGIN;

CREATE TABLE cloud_accounts.workload_configuration_revisions (
  organization_id uuid NOT NULL,
  project_id text NOT NULL,
  application_id text NOT NULL,
  environment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 32),
  log_level text NOT NULL CHECK (log_level IN ('error', 'warn', 'info')),
  request_timeout_ms integer NOT NULL CHECK (request_timeout_ms BETWEEN 100 AND 30000),
  saved_by uuid NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, application_id, environment_id, revision),
  FOREIGN KEY (organization_id, project_id, application_id, environment_id)
    REFERENCES cloud_accounts.registry_targets,
  FOREIGN KEY (organization_id, saved_by) REFERENCES cloud_accounts.memberships
);

CREATE FUNCTION cloud_accounts.read_workload_configuration(
  actor uuid, org uuid, project text, app text, environment text, requested_revision integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE saved jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cloud_accounts.registry_targets t
      JOIN cloud_accounts.registry_grants g USING (organization_id, project_id)
      JOIN cloud_accounts.memberships m USING (organization_id, account_id)
    WHERE t.organization_id = org AND t.project_id = project AND t.application_id = app
      AND t.environment_id = environment AND g.account_id = actor AND m.revoked_at IS NULL
  ) THEN RETURN NULL; END IF;

  SELECT jsonb_build_object('revision', r.revision, 'configuration', jsonb_build_object(
    'logLevel', r.log_level, 'requestTimeoutMs', r.request_timeout_ms), 'savedAt', r.saved_at)
    INTO saved FROM cloud_accounts.workload_configuration_revisions r
    WHERE r.organization_id = org AND r.project_id = project AND r.application_id = app
      AND r.environment_id = environment AND (requested_revision IS NULL OR r.revision = requested_revision)
    ORDER BY r.revision DESC LIMIT 1;
  IF saved IS NULL AND requested_revision IS NULL THEN
    RETURN jsonb_build_object('revision', 0, 'configuration', NULL);
  END IF;
  RETURN saved;
END;
$$;

CREATE FUNCTION cloud_accounts.save_workload_configuration(
  actor uuid, org uuid, project text, app text, environment text,
  expected_revision integer, requested_log_level text, requested_timeout_ms integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_revision integer;
  current_level text;
  current_timeout integer;
BEGIN
  IF expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 32 OR
     requested_log_level IS NULL OR requested_log_level NOT IN ('error', 'warn', 'info') OR
     requested_timeout_ms IS NULL OR requested_timeout_ms NOT BETWEEN 100 AND 30000 THEN
    RETURN jsonb_build_object('error', 'invalid_configuration');
  END IF;

  PERFORM 1 FROM cloud_accounts.registry_grants g
    JOIN cloud_accounts.memberships m USING (organization_id, account_id)
    WHERE g.organization_id = org AND g.project_id = project AND g.account_id = actor
      AND g.role = 'owner' AND m.revoked_at IS NULL FOR SHARE OF g, m;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Serialize revisions even when this registered environment has no configuration yet.
  PERFORM 1 FROM cloud_accounts.registry_targets t
    WHERE t.organization_id = org AND t.project_id = project AND t.application_id = app
      AND t.environment_id = environment FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT r.revision, r.log_level, r.request_timeout_ms INTO current_revision, current_level, current_timeout
    FROM cloud_accounts.workload_configuration_revisions r
    WHERE r.organization_id = org AND r.project_id = project AND r.application_id = app
      AND r.environment_id = environment ORDER BY r.revision DESC LIMIT 1;
  current_revision := COALESCE(current_revision, 0);
  IF expected_revision IN (current_revision, current_revision - 1)
     AND current_level = requested_log_level AND current_timeout = requested_timeout_ms THEN
    RETURN cloud_accounts.read_workload_configuration(actor, org, project, app, environment, current_revision);
  END IF;
  IF expected_revision <> current_revision THEN
    RETURN jsonb_build_object('error', 'configuration_changed');
  END IF;
  IF current_revision = 32 THEN
    RETURN jsonb_build_object('error', 'configuration_limit');
  END IF;
  INSERT INTO cloud_accounts.workload_configuration_revisions
    (organization_id, project_id, application_id, environment_id, revision, log_level, request_timeout_ms, saved_by)
    VALUES (org, project, app, environment, current_revision + 1, requested_log_level, requested_timeout_ms, actor);
  RETURN cloud_accounts.read_workload_configuration(actor, org, project, app, environment, current_revision + 1);
END;
$$;

REVOKE ALL ON TABLE cloud_accounts.workload_configuration_revisions FROM PUBLIC, paige_cloud_account_runtime;
REVOKE EXECUTE ON FUNCTION cloud_accounts.read_workload_configuration(uuid, uuid, text, text, text, integer),
  cloud_accounts.save_workload_configuration(uuid, uuid, text, text, text, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.read_workload_configuration(uuid, uuid, text, text, text, integer),
  cloud_accounts.save_workload_configuration(uuid, uuid, text, text, text, integer, text, integer)
TO paige_cloud_account_runtime;

COMMIT;
