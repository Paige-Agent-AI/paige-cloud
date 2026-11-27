BEGIN;

-- Delivery policy is changed by the database owner through reviewed operations.
-- The application role can reserve capacity but cannot change it.
CREATE TABLE cloud_accounts.account_email_capacity (
  singleton boolean PRIMARY KEY CHECK (singleton),
  provider_daily_capacity integer NOT NULL CHECK (provider_daily_capacity > 0),
  provider_headroom integer NOT NULL CHECK (provider_headroom > 0),
  enrollment_daily integer NOT NULL CHECK (enrollment_daily > 0),
  recovery_daily integer NOT NULL CHECK (recovery_daily > 0),
  enrollment_network_hourly integer NOT NULL CHECK (enrollment_network_hourly > 0),
  recovery_network_hourly integer NOT NULL CHECK (recovery_network_hourly > 0),
  enrollment_recipient_hourly integer NOT NULL CHECK (enrollment_recipient_hourly > 0),
  recovery_recipient_hourly integer NOT NULL CHECK (recovery_recipient_hourly > 0),
  CHECK (enrollment_daily::bigint + recovery_daily + provider_headroom <= provider_daily_capacity),
  CHECK (enrollment_recipient_hourly <= enrollment_network_hourly
    AND enrollment_network_hourly <= enrollment_daily),
  CHECK (recovery_recipient_hourly <= recovery_network_hourly
    AND recovery_network_hourly <= recovery_daily)
);

-- Preserve admission and existing counters on the incumbent Cognito sender.
INSERT INTO cloud_accounts.account_email_capacity VALUES (true, 50, 10, 20, 20, 5, 5, 2, 2);
REVOKE ALL ON TABLE cloud_accounts.account_email_capacity FROM PUBLIC, paige_cloud_account_runtime;

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
  -- This window matches Cognito default delivery. SES requires rolling-window qualification.
  day_window := date_trunc('day', checked_at - interval '9 hours', 'UTC') + interval '9 hours';
  SELECT coalesce(sum(attempts) FILTER (WHERE lane = 'enrollment'), 0),
         coalesce(sum(attempts) FILTER (WHERE lane = 'recovery'), 0)
    INTO enrollment_used, recovery_used
    FROM cloud_accounts.account_email_admission
    WHERE counter = 'global' AND window_start = day_window AND fingerprint = '-';
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
      (counter = 'global' AND window_start = day_window AND attempts >= daily_limit) OR
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
  RETURN true;
END;
$$;

COMMIT;
