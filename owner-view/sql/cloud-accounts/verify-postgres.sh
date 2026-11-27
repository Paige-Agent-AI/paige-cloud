#!/usr/bin/env bash
set -eu

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
container="paige-cloud-accounts-check-$$"
image="postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
docker run -d --rm --network none --name "$container" -e POSTGRES_HOST_AUTH_METHOD=trust "$image"
trap 'docker rm --force "$container" >/dev/null' EXIT

ready=false
for _ in {1..30}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true

verify_db() {
  docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"
}

verify_db -c 'CREATE ROLE paige_cloud_account_runtime NOLOGIN'
verify_db < "$dir/001-accounts.sql"
verify_db < "$dir/account-records.test.sql"

verify_db -c "SET ROLE paige_cloud_account_runtime;
  SELECT cloud_accounts.record_verified_identity('test-issuer', 'concurrent', 'parallel@example.test');"

first=$(mktemp)
second=$(mktemp)
trap 'rm -f "$first" "$second"; docker rm --force "$container" >/dev/null' EXIT

docker exec -i -e PGAPPNAME=onboarding_first "$container" psql -XAtq -U postgres -v ON_ERROR_STOP=1 >"$first" <<'SQL' &
SET statement_timeout = '12s';
SET ROLE paige_cloud_account_runtime;
BEGIN;
SELECT cloud_accounts.onboard_organization(
  cloud_accounts.find_verified_identity('test-issuer', 'concurrent'), 'Parallel'
)->>'id';
SELECT pg_sleep(4);
COMMIT;
SQL
first_pid=$!

first_holds_row=false
for _ in {1..20}; do
  if [[ "$(verify_db -Atq -c "SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE application_name = 'onboarding_first' AND wait_event = 'PgSleep'
  )")" = t ]]; then
    first_holds_row=true
    break
  fi
  sleep 0.1
done
test "$first_holds_row" = true

docker exec -i -e PGAPPNAME=onboarding_second "$container" psql -XAtq -U postgres -v ON_ERROR_STOP=1 >"$second" <<'SQL' &
SET statement_timeout = '12s';
SET ROLE paige_cloud_account_runtime;
SELECT cloud_accounts.onboard_organization(
  cloud_accounts.find_verified_identity('test-issuer', 'concurrent'), 'Parallel'
)->>'id';
SQL
second_pid=$!

waited=false
for _ in {1..20}; do
  if [[ "$(verify_db -Atq -c "SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE application_name = 'onboarding_second' AND wait_event_type = 'Lock'
  )")" = t ]]; then
    waited=true
    break
  fi
  sleep 0.1
done
test "$waited" = true
wait "$first_pid"
wait "$second_pid"
organization="$(head -n 1 "$first")"
[[ "$organization" =~ ^[a-f0-9-]{36}$ ]]
test "$organization" = "$(cat "$second")"
test 1 = "$(verify_db -Atq -c "SELECT count(*) FROM cloud_accounts.memberships WHERE organization_id = '$organization'")"
printf 'Confirmed one persisted organization and one membership after two concurrent requests.\n'
