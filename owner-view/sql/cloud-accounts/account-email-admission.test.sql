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
  IF has_table_privilege(current_user, 'cloud_accounts.account_email_admission', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'runtime can bypass email admission';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;
