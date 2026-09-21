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

for path in 'stock v7' 'v5 v6' 'v5 v7' 'v6 v7' 'previous-v7 v7'; do
  IFS=' ' read -r source target <<< "$path"
  (validate_transition "$source" "$target") || {
    printf 'ERROR: rejected supported transition %s->%s\n' "$source" "$target" >&2
    exit 1
  }
done
for path in 'stock v6' 'v6 v6' 'v7 v7' 'v7 v5' 'previous-v7 v6' 'previous-v7 previous-v7'; do
  IFS=' ' read -r source target <<< "$path"
  if (validate_transition "$source" "$target") 2>/dev/null; then
    printf 'ERROR: accepted unsupported transition %s->%s\n' "$source" "$target" >&2
    exit 1
  fi
done

# Execute the real admission and override functions with synthetic identities;
# no Docker daemon, production paths, secrets, or database is used.
(
  previous_id="sha256:$(printf 'e%.0s' {1..64})"
  previous_config_id="sha256:$(printf 'f%.0s' {1..64})"
  previous_enabled=true
  release_value() {
    case $1 in
      PREVIOUS_V7_IMAGE_ID) [[ $previous_enabled == true ]] && printf '%s\n' "$previous_id" || printf 'none\n' ;;
      PREVIOUS_V7_CONFIG_IMAGE_ID) [[ $previous_enabled == true ]] && printf '%s\n' "$previous_config_id" || printf 'none\n' ;;
      *) printf 'sha256:%s\n' "$(printf 'a%.0s' {1..64})" ;;
    esac
  }
  [[ $(supported_source_kind "$previous_id") == previous-v7 ]]
  [[ $(supported_source_kind "$previous_config_id") == previous-v7 ]]
  ! supported_source_kind "sha256:$(printf 'b%.0s' {1..64})"
  [[ $(source_override_kind previous-v7) == v7 ]]
  [[ $(source_override_kind v6) == v6 ]]
  [[ $(source_override_kind stock) == source ]]
  [[ $(source_override_kind v5) == source ]]
  ! (source_override_kind arbitrary) 2>/dev/null
  previous_enabled=false
  ! supported_source_kind "$previous_id"
  ! supported_source_kind none
  validate_v7_runtime_config() { return 0; }
  validate_running_target_environment() { [[ $1 == v7 ]]; }
  validate_previous_v7_source_environment previous-v7
  validate_v7_runtime_config() { return 1; }
  ! validate_previous_v7_source_environment previous-v7
  validate_v7_runtime_config() { return 0; }
  validate_running_target_environment() { return 1; }
  ! validate_previous_v7_source_environment previous-v7
  # Each package owns its load/active receipts; legacy receipts remain intact.
  [[ $V6_LOADED_STATE != "$IMAGE_STATE_DIR/loaded-v6.env" ]]
  [[ $V7_LOADED_STATE != "$IMAGE_STATE_DIR/loaded-v7.env" ]]
  [[ $V7_MONGO_LOADED_STATE != "$IMAGE_STATE_DIR/loaded-mongo-v7.env" ]]
  [[ $V7_ACTIVE_STATE != "$IMAGE_STATE_DIR/active-v7-transition.env" ]]

  fixture=$(mktemp -d)
  trap 'rm -rf -- "$fixture"' EXIT
  manifest_value() {
    case $2 in
      oauth_secret_key) printf 'AAAAAAAAAAAAAAAAAAAAAA==\n' ;;
      private_integration_hosts) printf 'tickets.example.test\n' ;;
      *) return 1 ;;
    esac
  }
  write_transition_override "$fixture/candidate.yml" local/titra:candidate v7
  write_transition_override "$fixture/rollback.yml" local/titra:preserved "$(source_override_kind previous-v7)"
  for path in "$fixture/candidate.yml" "$fixture/rollback.yml"; do
    grep -Fx '      TITRA_OAUTH_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAA=="' "$path" >/dev/null
    grep -Fx '      TITRA_PRIVATE_INTEGRATION_HOSTS: "tickets.example.test"' "$path" >/dev/null
    grep -Fx '      TITRA_FENCE_RECOVERY_MODE: single-instance' "$path" >/dev/null
    [[ $(stat -c %a "$path") == 600 ]]
  done
  cmp --silent <(sed '/    image:/d' "$fixture/candidate.yml") <(sed '/    image:/d' "$fixture/rollback.yml")
  write_transition_override "$fixture/v6.yml" local/titra:old "$(source_override_kind v6)"
  ! grep -E 'TITRA_(OAUTH_SECRET_KEY|PRIVATE_INTEGRATION_HOSTS)' "$fixture/v6.yml"
)

# Run the real install guard in an isolated shell. Synthetic stat results allow
# owner/mode failure checks without requiring root or touching protected paths.
(
  fixture=$(mktemp -d)
  trap 'rm -rf -- "$fixture"' EXIT
  installer="$SCRIPT_DIR/../root-scripts/install.sh"
  guard=$(sed -n '/^require_previous_v7_runtime_configuration() {$/,/^}$/p' "$installer")
  [[ -n $guard ]]
  (
    # A fresh shell avoids the sourced common.sh readonly runtime path.
    printf '%s\n' "$guard"
    cat <<'REHEARSAL'
set -eu
die() { exit 1; }
EXPECTED_PREVIOUS_V7_IMAGE_ID=enabled
V7_RUNTIME_CONFIG=$1/runtime.env
! (require_previous_v7_runtime_configuration)
: > "$V7_RUNTIME_CONFIG"
stat() { printf '%s\n' "$synthetic_stat"; }
synthetic_stat=1000:1000:600:1
! (require_previous_v7_runtime_configuration)
synthetic_stat=0:0:644:1
! (require_previous_v7_runtime_configuration)
synthetic_stat=0:0:600:2
! (require_previous_v7_runtime_configuration)
synthetic_stat=0:0:600:1
require_previous_v7_runtime_configuration
mv "$V7_RUNTIME_CONFIG" "$1/real.env"
ln -s "$1/real.env" "$V7_RUNTIME_CONFIG"
! (require_previous_v7_runtime_configuration)
EXPECTED_PREVIOUS_V7_IMAGE_ID=none
require_previous_v7_runtime_configuration
REHEARSAL
  ) | bash -s -- "$fixture"
)

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
