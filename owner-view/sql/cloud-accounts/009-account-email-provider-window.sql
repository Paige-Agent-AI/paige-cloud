BEGIN;

ALTER TABLE cloud_accounts.account_email_capacity
  ADD COLUMN provider_window text NOT NULL DEFAULT 'cognito_daily',
  ADD COLUMN provider_rate_per_second integer,
  ADD CONSTRAINT account_email_provider_window CHECK (
    (provider_window = 'cognito_daily' AND provider_rate_per_second IS NULL) OR
    (provider_window = 'ses_rolling' AND provider_rate_per_second IS NOT NULL AND provider_rate_per_second > 0)
  );

-- One reservation per potential provider send; no network or recipient identifiers are needed here.
CREATE TABLE cloud_accounts.account_email_send_window (
  admitted_at timestamptz NOT NULL,
  lane text NOT NULL CHECK (lane IN ('enrollment', 'recovery')),
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (admitted_at, lane)
);
REVOKE ALL ON TABLE cloud_accounts.account_email_send_window FROM PUBLIC, paige_cloud_account_runtime;

CREATE OR REPLACE FUNCTION cloud_accounts.reserve_account_email(lane_name text, network_key text, recipient_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  capacity cloud_accounts.account_email_capacity%ROWTYPE;
  daily_limit integer;
  network_limit integer;
  recipient_limit integer;
  enrollment_used bigint;
  recovery_used bigint;
  recent_used bigint;
  checked_at timestamptz;
  hour_window timestamptz;
  day_window timestamptz;
BEGIN
  IF lane_name IS NULL OR lane_name NOT IN ('enrollment', 'recovery') OR
     network_key IS NULL OR network_key !~ '^[a-f0-9]{64}$' OR
     recipient_key IS NULL OR recipient_key !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;

  -- Reallocations must account for today's admissions under every earlier policy.
  PERFORM pg_advisory_xact_lock(hashtextextended('paige-cloud-account-email:capacity', 0));
  -- Share the original lane lock with requests already executing during the migration.
  PERFORM pg_advisory_xact_lock(hashtextextended('paige-cloud-account-email:' || lane_name, 0));
  SELECT * INTO capacity FROM cloud_accounts.account_email_capacity WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF lane_name = 'enrollment' THEN
    daily_limit := capacity.enrollment_daily;
    network_limit := capacity.enrollment_network_hourly;
    recipient_limit := capacity.enrollment_recipient_hourly;
  ELSE
    daily_limit := capacity.recovery_daily;
    network_limit := capacity.recovery_network_hourly;
    recipient_limit := capacity.recovery_recipient_hourly;
  END IF;

  checked_at := clock_timestamp();
  hour_window := date_trunc('hour', checked_at, 'UTC');
  -- Record each path during the transition so switching policy never grants a fresh rolling allowance.
  DELETE FROM cloud_accounts.account_email_send_window
    WHERE admitted_at < checked_at - interval '24 hours 30 seconds';
  day_window := date_trunc('day', checked_at - interval '9 hours', 'UTC') + interval '9 hours';
  IF capacity.provider_window = 'ses_rolling' THEN
    -- The account Lambda has a 28-second timeout. Account for potential provider acceptance after admission.
    SELECT coalesce(sum(attempts) FILTER (WHERE lane = 'enrollment'), 0),
           coalesce(sum(attempts) FILTER (WHERE lane = 'recovery'), 0),
           coalesce(sum(attempts) FILTER (WHERE admitted_at > checked_at - interval '1 second'), 0)
      INTO enrollment_used, recovery_used, recent_used
      FROM cloud_accounts.account_email_send_window;
    IF recent_used >= capacity.provider_rate_per_second THEN RETURN false; END IF;
  ELSE
    SELECT coalesce(sum(attempts) FILTER (WHERE lane = 'enrollment'), 0),
           coalesce(sum(attempts) FILTER (WHERE lane = 'recovery'), 0)
      INTO enrollment_used, recovery_used
      FROM cloud_accounts.account_email_admission
      WHERE counter = 'global' AND window_start = day_window AND fingerprint = '-';
  END IF;
  IF (lane_name = 'enrollment' AND enrollment_used >= daily_limit) OR
     (lane_name = 'recovery' AND recovery_used >= daily_limit) THEN RETURN false; END IF;
  IF enrollment_used + recovery_used >= capacity.provider_daily_capacity - capacity.provider_headroom THEN
    RETURN false;
  END IF;
  IF lane_name = 'enrollment' AND
    enrollment_used + greatest(recovery_used, capacity.recovery_daily) >=
      capacity.provider_daily_capacity - capacity.provider_headroom THEN RETURN false; END IF;

  DELETE FROM cloud_accounts.account_email_admission
    WHERE lane = lane_name AND window_start < checked_at - interval '2 days';
  IF EXISTS (
    SELECT 1 FROM cloud_accounts.account_email_admission
    WHERE lane = lane_name AND (
      (counter = 'network' AND window_start = hour_window AND fingerprint = network_key AND attempts >= network_limit) OR
      (counter = 'recipient' AND window_start = hour_window AND fingerprint = recipient_key AND attempts >= recipient_limit)
    )
  ) THEN RETURN false; END IF;

  INSERT INTO cloud_accounts.account_email_admission (lane, counter, window_start, fingerprint, attempts)
    VALUES (lane_name, 'global', day_window, '-', 1),
           (lane_name, 'network', hour_window, network_key, 1),
           (lane_name, 'recipient', hour_window, recipient_key, 1)
  ON CONFLICT (lane, counter, window_start, fingerprint)
  DO UPDATE SET attempts = account_email_admission.attempts + 1;
  INSERT INTO cloud_accounts.account_email_send_window (admitted_at, lane, attempts)
    VALUES (checked_at, lane_name, 1)
    ON CONFLICT (admitted_at, lane)
    DO UPDATE SET attempts = account_email_send_window.attempts + 1;
  RETURN true;
END;
$$;

COMMIT;
