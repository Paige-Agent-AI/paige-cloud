BEGIN;

SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  i integer;
BEGIN
  IF cloud_accounts.reserve_account_email('unknown', repeat('a', 64), repeat('b', 64))
     OR cloud_accounts.reserve_account_email('enrollment', '192.0.2.1', 'someone@example.test') THEN
    RAISE EXCEPTION 'unexpected email lane or raw identifier was accepted';
  END IF;
  IF NOT cloud_accounts.reserve_account_email('enrollment', repeat('a', 64), repeat('b', 64))
     OR NOT cloud_accounts.reserve_account_email('enrollment', repeat('c', 64), repeat('b', 64))
     OR cloud_accounts.reserve_account_email('enrollment', repeat('d', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'the same recipient can bypass the limit through different requesters';
  END IF;
  IF NOT cloud_accounts.reserve_account_email('recovery', repeat('d', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'enrollment consumed the separate recovery budget';
  END IF;
  FOR i IN 1..4 LOOP
    IF NOT cloud_accounts.reserve_account_email('enrollment', repeat('c', 64), lpad(i::text, 64, '0')) THEN
      RAISE EXCEPTION 'network quota was reached early';
    END IF;
  END LOOP;
  IF cloud_accounts.reserve_account_email('enrollment', repeat('c', 64), repeat('e', 64)) THEN
    RAISE EXCEPTION 'network exceeded its hourly quota';
  END IF;
  FOR i IN 1..14 LOOP
    IF NOT cloud_accounts.reserve_account_email('enrollment', lpad(i::text, 64, 'a'), lpad(i::text, 64, 'f')) THEN
      RAISE EXCEPTION 'global enrollment quota was reached early';
    END IF;
  END LOOP;
  IF cloud_accounts.reserve_account_email('enrollment', repeat('f', 64), repeat('d', 64)) THEN
    RAISE EXCEPTION 'enrollment exceeded its daily budget';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_locks
    WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
      AND (classid::bigint << 32 | objid::bigint) =
          hashtextextended('paige-cloud-account-email:enrollment', 0)
  ) THEN
    RAISE EXCEPTION 'admission no longer shares the legacy lane lock during upgrade';
  END IF;
  IF has_table_privilege(current_user, 'cloud_accounts.account_email_admission', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'runtime can bypass email admission';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;

BEGIN;

SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 1..20 LOOP
    IF NOT cloud_accounts.reserve_account_email('enrollment', lpad(i::text, 64, 'a'), lpad(i::text, 64, 'b')) THEN
      RAISE EXCEPTION 'default enrollment capacity was unavailable before reallocation';
    END IF;
  END LOOP;
END
$$;
RESET ROLE;
UPDATE cloud_accounts.account_email_capacity SET enrollment_daily = 10, recovery_daily = 30;
SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 1..20 LOOP
    IF NOT cloud_accounts.reserve_account_email('recovery', lpad(i::text, 64, 'a'), lpad(i::text, 64, 'b')) THEN
      RAISE EXCEPTION 'protected unspent recovery capacity was unavailable after reallocation';
    END IF;
  END LOOP;
  IF cloud_accounts.reserve_account_email('recovery', repeat('a', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'midday reallocation reused already reserved capacity';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;

BEGIN;

DO $$
BEGIN
  BEGIN
    UPDATE cloud_accounts.account_email_capacity SET enrollment_daily = 21;
    RAISE EXCEPTION 'the policy allocated the provider headroom to enrollment';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

UPDATE cloud_accounts.account_email_capacity
SET enrollment_daily = 7, enrollment_network_hourly = 7, enrollment_recipient_hourly = 1,
    recovery_daily = 3, recovery_network_hourly = 3, recovery_recipient_hourly = 1;

SET ROLE paige_cloud_account_runtime;
DO $$
DECLARE
  i integer;
BEGIN
  IF has_table_privilege(current_user, 'cloud_accounts.account_email_capacity', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'runtime can access the delivery policy directly';
  END IF;
  FOR i IN 1..7 LOOP
    IF NOT cloud_accounts.reserve_account_email('enrollment', repeat('a', 64), lpad(i::text, 64, '0')) THEN
      RAISE EXCEPTION 'different people behind the same network could not enroll under revised policy';
    END IF;
    IF cloud_accounts.reserve_account_email('enrollment', repeat('c', 64), lpad(i::text, 64, '0')) THEN
      RAISE EXCEPTION 'the revised recipient limit was not enforced independently of network';
    END IF;
  END LOOP;
  IF cloud_accounts.reserve_account_email('enrollment', repeat('b', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'the revised enrollment limit was exceeded';
  END IF;
  FOR i IN 1..3 LOOP
    IF NOT cloud_accounts.reserve_account_email('recovery', repeat('a', 64), lpad(i::text, 64, '0')) THEN
      RAISE EXCEPTION 'a saturated enrollment lane consumed reserved recovery capacity';
    END IF;
  END LOOP;
  IF cloud_accounts.reserve_account_email('recovery', repeat('b', 64), repeat('b', 64)) THEN
    RAISE EXCEPTION 'the revised recovery limit was exceeded';
  END IF;
END
$$;
RESET ROLE;

DELETE FROM cloud_accounts.account_email_capacity;
SET ROLE paige_cloud_account_runtime;
DO $$
BEGIN
  IF cloud_accounts.reserve_account_email('enrollment', repeat('f', 64), repeat('e', 64))
     OR cloud_accounts.reserve_account_email('recovery', repeat('f', 64), repeat('e', 64)) THEN
    RAISE EXCEPTION 'missing capacity policy did not fail closed';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;
