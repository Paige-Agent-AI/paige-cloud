BEGIN;

DO $$
BEGIN
  IF (SELECT provider_window FROM cloud_accounts.account_email_capacity) <> 'cognito_daily' THEN
    RAISE EXCEPTION 'migration switched transport admission without an operator';
  END IF;
  BEGIN
    UPDATE cloud_accounts.account_email_capacity SET provider_window = 'ses_rolling';
    RAISE EXCEPTION 'SES policy accepted a missing send rate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;

SET ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF has_table_privilege(current_user, 'cloud_accounts.account_email_send_window',
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'runtime can modify the provider send window directly';
  END IF;
  IF NOT cloud_accounts.reserve_account_email('enrollment', repeat('a', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'default Cognito policy failed before switching sender';
  END IF;
END
$$;
RESET ROLE;

-- Model a prior admission in the rolling window but well outside the per-second budget.
UPDATE cloud_accounts.account_email_send_window SET admitted_at = clock_timestamp() - interval '23 hours';
UPDATE cloud_accounts.account_email_capacity
  SET provider_window = 'ses_rolling', provider_rate_per_second = 1, provider_daily_capacity = 3,
      provider_headroom = 1, enrollment_daily = 1, recovery_daily = 1,
      enrollment_network_hourly = 1, recovery_network_hourly = 1,
      enrollment_recipient_hourly = 1, recovery_recipient_hourly = 1;

SET ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF cloud_accounts.reserve_account_email('enrollment', repeat('e', 64), repeat('f', 64)) THEN
    RAISE EXCEPTION 'previous sender usage disappeared during the rolling policy transition';
  END IF;
  IF NOT cloud_accounts.reserve_account_email('recovery', repeat('e', 64), repeat('f', 64)) THEN
    RAISE EXCEPTION 'enrollment used the reserved rolling recovery allocation';
  END IF;
END
$$;
RESET ROLE;

UPDATE cloud_accounts.account_email_capacity
  SET provider_daily_capacity = 5, enrollment_daily = 2, recovery_daily = 2;
SET ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF cloud_accounts.reserve_account_email('enrollment', repeat('e', 64), repeat('a', 64)) THEN
    RAISE EXCEPTION 'shared rate limit did not count the recovery admission';
  END IF;
END
$$;
RESET ROLE;

UPDATE cloud_accounts.account_email_send_window
  SET admitted_at = clock_timestamp() - CASE lane WHEN 'enrollment' THEN interval '25 hours' ELSE interval '2 seconds' END;
SET ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF NOT cloud_accounts.reserve_account_email('enrollment', repeat('e', 64), repeat('a', 64)) THEN
    RAISE EXCEPTION 'old reservations blocked a new send beyond their window';
  END IF;
END
$$;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cloud_accounts.account_email_send_window
      WHERE admitted_at < clock_timestamp() - interval '25 hours') THEN
    RAISE EXCEPTION 'expired rolling reservation was retained';
  END IF;
END
$$;

ROLLBACK;
