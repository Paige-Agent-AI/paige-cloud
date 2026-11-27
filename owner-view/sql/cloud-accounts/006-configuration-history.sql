BEGIN;

ALTER TABLE cloud_accounts.workload_configuration_revisions
  DROP CONSTRAINT workload_configuration_revisions_revision_check,
  ADD CONSTRAINT workload_configuration_revision_positive CHECK (revision > 0);

CREATE OR REPLACE FUNCTION cloud_accounts.save_workload_configuration(
  actor uuid, org uuid, project text, app text, environment text,
  expected_revision integer, requested_log_level text, requested_timeout_ms integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_revision integer;
  current_level text;
  current_timeout integer;
  last_saved_at timestamptz;
BEGIN
  IF expected_revision IS NULL OR expected_revision < 0 OR
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

  SELECT r.revision, r.log_level, r.request_timeout_ms, r.saved_at
    INTO current_revision, current_level, current_timeout, last_saved_at
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
  IF current_revision = 2147483647 THEN
    RETURN jsonb_build_object('error', 'configuration_limit');
  END IF;
  -- The lock above serializes the write budget as well as optimistic revision checks.
  IF last_saved_at > clock_timestamp() - interval '1 minute' THEN
    RETURN jsonb_build_object('error', 'configuration_rate_limited');
  END IF;
  INSERT INTO cloud_accounts.workload_configuration_revisions
    (organization_id, project_id, application_id, environment_id, revision, log_level, request_timeout_ms, saved_by)
    VALUES (org, project, app, environment, current_revision + 1, requested_log_level, requested_timeout_ms, actor);
  RETURN cloud_accounts.read_workload_configuration(actor, org, project, app, environment, current_revision + 1);
END;
$$;

COMMIT;
