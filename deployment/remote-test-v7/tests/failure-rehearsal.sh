#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
LC_ALL=C
export LC_ALL
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=../root-scripts/common.sh
source "${SCRIPT_DIR}/../root-scripts/common.sh"
# shellcheck source=../root-scripts/v7-transition.sh
source "${SCRIPT_DIR}/../root-scripts/v7-transition.sh"

for accepted in '' 'tickets.example.test' 'tickets.example.test,git.example.test' '10.20.30.40' '[fd00::10]'; do
  validate_private_integration_hosts "$accepted" || {
    printf 'ERROR: rejected safe private-host value: %s\n' "$accepted" >&2
    exit 1
  }
done
for rejected in '*.example.test' 'https://example.test' 'example.test:8443' 'Example.test' 'one.example, two.example' '../example' $'bad\nhost'; do
  if validate_private_integration_hosts "$rejected"; then
    printf 'ERROR: accepted unsafe private-host value: %s\n' "$rejected" >&2
    exit 1
  fi
done

for path in 'stock v7' 'v5 v6' 'v5 v7' 'v6 v7'; do
  IFS=' ' read -r source target <<< "$path"
  (validate_transition "$source" "$target") || {
    printf 'ERROR: rejected supported transition %s->%s\n' "$source" "$target" >&2
    exit 1
  }
done
for path in 'stock v6' 'v6 v6' 'v7 v7' 'v7 v5'; do
  IFS=' ' read -r source target <<< "$path"
  if (validate_transition "$source" "$target") 2>/dev/null; then
    printf 'ERROR: accepted unsupported transition %s->%s\n' "$source" "$target" >&2
    exit 1
  fi
done

rollback="${SCRIPT_DIR}/../root-scripts/rollback-production-candidate.sh"
grep -F 'application-only rollback mode' "$rollback" >/dev/null
grep -F 'drop_production_database' "$rollback" >/dev/null
grep -F 'restore_archive_to_production "$pinned_archive"' "$rollback" >/dev/null
if grep -Eq 'WITHOUT DATABASE RESTORE|acknowledge-migrated-data-remains' "$rollback"; then
  printf 'ERROR: rollback exposes a forbidden application-only escape hatch.\n' >&2
  exit 1
fi

data_gate="${SCRIPT_DIR}/../root-scripts/preflight-v7-data-compatibility.sh"
production_preflight="${SCRIPT_DIR}/../root-scripts/preflight-production-deploy.sh"
deploy="${SCRIPT_DIR}/../root-scripts/deploy-production-candidate.sh"
backup="${SCRIPT_DIR}/../root-scripts/backup-production-db.sh"
grep -F -- '--preview' "$data_gate" >/dev/null
grep -F -- '--require-app-stopped' "$data_gate" >/dev/null
grep -F 'LOCK_INHERITED == true' "$data_gate" >/dev/null
grep -F 'mongosh "$PROD_DATABASE" --quiet --norc --file /dev/stdin' "$data_gate" >/dev/null
grep -F '> "$output_file" 2>&1' "$data_gate" >/dev/null
grep -F "printf '%s\n' \"\$marker\" >/dev/tty" "$data_gate" >/dev/null
grep -F 'ACKNOWLEDGE V7 DATA COMPATIBILITY WARNINGS' "$data_gate" >/dev/null
grep -F 'marker_count migration_lock_active' "$data_gate" >/dev/null
grep -F "return new Set()" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F "'secure_webhook_missing_secrets'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F "'verification_unrecoverable_pending'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F 'preflight-v7-data-compatibility.sh" --preview' "$production_preflight" >/dev/null
grep -F 'preflight-v7-data-compatibility.sh" --require-app-stopped' "$deploy" >/dev/null
grep -F -- '--leave-app-stopped --dry-run' "$deploy" >/dev/null
grep -F -- '--leave-app-stopped' "$backup" >/dev/null
grep -F 'LOCK_INHERITED == true' "$backup" >/dev/null
grep -F 'Application handoff: exact source container remains stopped' "$backup" >/dev/null
grep -F -- '--leave-app-stopped --dry-run' "$rollback" >/dev/null
grep -F 'exact-target-restarted-before-restore' "$rollback" >/dev/null
grep -F 'target_replacement_started == true' "$rollback" >/dev/null
grep -F "'credential_object_fields'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F "'credential_oversized_plaintext_fields'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F "'admin_inactive_flags_malformed'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F "'dashboard_slug_key_shape_malformed'" "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
grep -F 'function verificationMalformedFlagsPipeline' "${SCRIPT_DIR}/../root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null
if grep -Eq '(cat|head|tail|sed)[[:space:]]+(--[[:space:]]+)?"?\$output_file' "$data_gate"; then
  printf 'ERROR: compatibility gate can expose unsanitized Mongo output.\n' >&2
  exit 1
fi

printf 'R7 failure-policy rehearsal passed.\n'
