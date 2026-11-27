BEGIN;

CREATE TABLE cloud_accounts.account_email_admission (
  lane text NOT NULL CHECK (lane IN ('enrollment', 'recovery')),
  counter text NOT NULL CHECK (counter IN ('global', 'network', 'recipient')),
  window_start timestamptz NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint = '-' OR fingerprint ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (lane, counter, window_start, fingerprint)
);

CREATE FUNCTION cloud_accounts.reserve_account_email(lane_name text, network_key text, recipient_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  checked_at timestamptz;
  hour_window timestamptz;
  day_window timestamptz;
BEGIN
  IF lane_name IS NULL OR lane_name NOT IN ('enrollment', 'recovery') OR
     network_key IS NULL OR network_key !~ '^[a-f0-9]{64}$' OR
     recipient_key IS NULL OR recipient_key !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;

  -- This serializes admission across concurrent senders before contacting the email provider.
  PERFORM pg_advisory_xact_lock(hashtextextended('paige-cloud-account-email:' || lane_name, 0));
  checked_at := clock_timestamp();
  hour_window := date_trunc('hour', checked_at, 'UTC');
  -- Cognito default email delivery's daily quota resets at 09:00 UTC.
  day_window := date_trunc('day', checked_at - interval '9 hours', 'UTC') + interval '9 hours';
  DELETE FROM cloud_accounts.account_email_admission
    WHERE lane = lane_name AND window_start < checked_at - interval '2 days';
  IF EXISTS (
    SELECT 1 FROM cloud_accounts.account_email_admission
    WHERE lane = lane_name AND (
      (counter = 'global' AND window_start = day_window AND attempts >= 20) OR
      (counter = 'network' AND window_start = hour_window AND fingerprint = network_key AND attempts >= 5) OR
      (counter = 'recipient' AND window_start = hour_window AND fingerprint = recipient_key AND attempts >= 2)
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

REVOKE ALL ON TABLE cloud_accounts.account_email_admission FROM PUBLIC, paige_cloud_account_runtime;
REVOKE EXECUTE ON FUNCTION cloud_accounts.reserve_account_email(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accounts.reserve_account_email(text, text, text) TO paige_cloud_account_runtime;

COMMIT;
