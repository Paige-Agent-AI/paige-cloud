BEGIN;

CREATE TABLE cloud_accounts.workload_observation_budget (
  organization_id uuid PRIMARY KEY REFERENCES cloud_accounts.organizations(id),
  utc_day date NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 24),
  reserved_at timestamptz NOT NULL
);

CREATE FUNCTION cloud_accounts.reserve_workload_observation(
  actor uuid, org uuid, project text, app text, environment text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  instant timestamptz := clock_timestamp();
  today date := (instant AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM 1 FROM cloud_accounts.registry_targets t
    JOIN cloud_accounts.registry_grants g ON g.organization_id = t.organization_id AND g.project_id = t.project_id
    JOIN cloud_accounts.memberships m ON m.organization_id = g.organization_id AND m.account_id = g.account_id
    WHERE t.organization_id = org AND t.project_id = project AND t.application_id = app
      AND t.environment_id = environment AND g.account_id = actor AND m.revoked_at IS NULL
    FOR SHARE OF t, g, m;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO cloud_accounts.workload_observation_budget AS budget
    (organization_id, utc_day, attempts, reserved_at) VALUES (org, today, 1, instant)
  ON CONFLICT (organization_id) DO UPDATE SET
    utc_day = today,
    attempts = CASE WHEN budget.utc_day = today THEN budget.attempts + 1 ELSE 1 END,
    reserved_at = instant
  WHERE budget.reserved_at <= instant - interval '30 seconds'
    AND (budget.utc_day < today OR (budget.utc_day = today AND budget.attempts < 24));
  IF FOUND THEN RETURN 'reserved'; END IF;
  RETURN 'limited';
END;
$$;

REVOKE ALL ON TABLE cloud_accounts.workload_observation_budget FROM PUBLIC, paige_cloud_account_runtime;
REVOKE EXECUTE ON FUNCTION cloud_accounts.reserve_workload_observation(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.reserve_workload_observation(uuid, uuid, text, text, text) TO paige_cloud_account_runtime;

COMMIT;
