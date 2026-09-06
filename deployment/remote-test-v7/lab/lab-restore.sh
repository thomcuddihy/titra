#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TITRA_LAB_LOCK_MODE='exclusive'
# shellcheck source=lock-bootstrap.sh
source "$SCRIPT_DIR/lock-bootstrap.sh"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  printf 'Usage: %s BACKUP_DIRECTORY --replace-isolated-lab\n' "$(basename -- "$0")" >&2
  exit 2
}

[[ "$#" == '2' && "$2" == '--replace-isolated-lab' ]] || usage

prepare_operation exclusive
verify_release_images
ensure_state_directories
require_command sha256sum
require_command date
require_command sed

backup_dir="$(realpath -e -- "$1")"
[[ "$backup_dir" == "$PRODUCTION_BACKUP_ROOT/"* ]] || die "Backup must be under $PRODUCTION_BACKUP_ROOT"
[[ "$(dirname -- "$backup_dir")" == "$PRODUCTION_BACKUP_ROOT" ]] || die 'Pass one direct production backup directory, not an arbitrary nested path.'
require_secure_root_file "$backup_dir/manifest.env"

archive="$backup_dir/titra.archive.gz"
sidecar="$backup_dir/titra.archive.gz.sha256"
manifest="$backup_dir/manifest.env"
database_summary="$backup_dir/database-summary.json"
for path in "$backup_dir" "$archive" "$sidecar" "$manifest" "$database_summary"; do
  [[ ! -L "$path" ]] || die "Backup artifact must not be a symlink: $path"
  [[ "$(stat -Lc '%u' -- "$path")" == '0' ]] || die "Backup artifact is not root-owned: $path"
  mode="$(stat -Lc '%a' -- "$path")"
  numeric=$((8#$mode))
  (( (numeric & 0022) == 0 )) || die "Backup artifact is group/other writable: $path"
done
[[ -f "$archive" && -f "$sidecar" && -f "$manifest" && -f "$database_summary" ]] || die 'Backup directory is incomplete.'

declare -A BACKUP_VALUES=()
read_literal_env_file "$manifest" BACKUP_VALUES

backup_id="$(basename -- "$backup_dir")"
[[ "$backup_id" =~ ^prod-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || die 'Production backup directory has an invalid ID.'
expected_manifest_keys='format_version,backup_id,source_host,source_project,source_service,source_container,source_database,archive_format,archive_file,archive_sha256,app_quiesced,restore_dry_run,database_summary_file,database_summary_sha256,collection_count,document_count,index_count,database_total_size_bytes,created_utc,completed_utc,purpose,operator,change_ticket,production_compose_sha256,app_image_ref,app_image_id,app_container_id,mongo_container_id,mongo_image_id,mongo_server_version,mongo_tools_version'
actual_manifest_keys="$(awk -F= 'BEGIN { separator="" } { printf "%s%s", separator, $1; separator="," } END { print "" }' "$manifest")"
[[ "$actual_manifest_keys" == "$expected_manifest_keys" ]] || die 'Backup manifest has missing, duplicate, reordered, or unknown keys.'
[[ "${BACKUP_VALUES[format_version]:-}" == "$BACKUP_FORMAT_VERSION" ]] || die 'Only backup manifest format 2 is accepted.'
[[ "${BACKUP_VALUES[backup_id]:-}" == "$backup_id" ]] || die 'Backup manifest ID does not match its directory.'
[[ "${BACKUP_VALUES[source_host]:-}" == "$EXPECTED_HOST_FQDN" ]] || die 'Backup was created on another host.'
[[ "${BACKUP_VALUES[source_project]:-}" == "$PRODUCTION_PROJECT" ]] || die 'Backup was created from another Compose project.'
[[ "${BACKUP_VALUES[source_service]:-}" == "$PRODUCTION_DB_SERVICE" ]] || die 'Backup was created from another Mongo service.'
[[ "${BACKUP_VALUES[source_container]:-}" == "$PRODUCTION_DB_CONTAINER" ]] || die 'Backup was created from another Mongo container.'
[[ "${BACKUP_VALUES[source_database]:-}" == "$PRODUCTION_DATABASE" ]] || die 'The backup source database must be titra.'
[[ "${BACKUP_VALUES[archive_format]:-}" == 'mongodump-archive-gzip' ]] || die 'The backup is not a gzip mongodump archive.'
[[ "${BACKUP_VALUES[archive_file]:-}" == 'titra.archive.gz' ]] || die 'Unexpected archive filename in backup manifest.'
[[ "${BACKUP_VALUES[archive_sha256]:-}" =~ ^[0-9a-f]{64}$ ]] || die 'Invalid archive checksum in backup manifest.'
[[ "${BACKUP_VALUES[app_quiesced]:-}" == 'true' ]] || die 'Refusing a production backup that was not taken with the app quiesced.'
[[ "${BACKUP_VALUES[restore_dry_run]:-}" == 'true' ]] || die 'Production backup did not record its successful source-side dry run.'
[[ "${BACKUP_VALUES[database_summary_file]:-}" == 'database-summary.json' ]] || die 'Unexpected database summary filename in backup manifest.'
[[ "${BACKUP_VALUES[database_summary_sha256]:-}" =~ ^[0-9a-f]{64}$ ]] || die 'Invalid database summary checksum in backup manifest.'
[[ "${BACKUP_VALUES[production_compose_sha256]:-}" == "$EXPECTED_PRODUCTION_COMPOSE_SHA256" ]] || die 'Backup was made against an unexpected production Compose definition.'
for summary_total in collection_count document_count index_count database_total_size_bytes; do
  [[ "${BACKUP_VALUES[$summary_total]:-}" =~ ^[0-9]+$ ]] || die "Invalid $summary_total in backup manifest."
done
[[ "${BACKUP_VALUES[app_image_ref]:-}" != '' ]] || die 'Backup application image reference is empty.'
[[ "${BACKUP_VALUES[app_image_id]:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Backup application image ID is invalid.'
[[ "${BACKUP_VALUES[app_container_id]:-}" =~ ^[0-9a-f]{64}$ ]] || die 'Backup application container ID is invalid.'
[[ "${BACKUP_VALUES[mongo_container_id]:-}" =~ ^[0-9a-f]{64}$ ]] || die 'Backup Mongo container ID is invalid.'
[[ "${BACKUP_VALUES[mongo_image_id]:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Backup Mongo image ID is invalid.'
[[ "${BACKUP_VALUES[mongo_server_version]:-}" =~ ^[0-9]+\.[0-9]+([.][0-9A-Za-z_.+-]+)?$ ]] || die 'Backup Mongo server version is invalid.'
[[ "${BACKUP_VALUES[mongo_tools_version]:-}" != '' ]] || die 'Backup Mongo tools version is empty.'
[[ "${BACKUP_VALUES[operator]:-}" != '' ]] || die 'Backup operator provenance is empty.'
created_epoch="$(date -u -d "${BACKUP_VALUES[created_utc]:-}" '+%s' 2>/dev/null)" || die 'Backup creation time is invalid.'
completed_epoch="$(date -u -d "${BACKUP_VALUES[completed_utc]:-}" '+%s' 2>/dev/null)" || die 'Backup completion time is invalid.'
(( completed_epoch >= created_epoch )) || die 'Backup completion precedes its creation time.'

IFS=' ' read -r sidecar_hash sidecar_name extra < "$sidecar" || die 'Unable to read archive checksum sidecar.'
[[ "$sidecar_hash" =~ ^[0-9a-f]{64}$ && "$sidecar_name" == 'titra.archive.gz' && -z "${extra:-}" ]] || die 'Malformed archive checksum sidecar.'
[[ "$sidecar_hash" == "${BACKUP_VALUES[archive_sha256]}" ]] || die 'Backup manifest and sidecar checksums differ.'
actual_hash="$(sha256sum -- "$archive")"
actual_hash="${actual_hash%% *}"
[[ "$actual_hash" == "$sidecar_hash" ]] || die 'Production backup checksum verification failed.'
summary_actual_hash="$(sha256sum -- "$database_summary")"
summary_actual_hash="${summary_actual_hash%% *}"
[[ "$summary_actual_hash" == "${BACKUP_VALUES[database_summary_sha256]}" ]] || die 'Production database-summary checksum verification failed.'
expected_database_summary="$(<"$database_summary")"
[[ "$expected_database_summary" == '{"database":"titra","collectionCount":'* ]] || die 'Production database-summary structure is invalid.'
summary_collection_count="$(sed -nE 's/^\{"database":"titra","collectionCount":([0-9]+),"documentCount":[0-9]+,"indexCount":[0-9]+,"collections":\[.*$/\1/p' "$database_summary")"
summary_document_count="$(sed -nE 's/^\{"database":"titra","collectionCount":[0-9]+,"documentCount":([0-9]+),"indexCount":[0-9]+,"collections":\[.*$/\1/p' "$database_summary")"
summary_index_count="$(sed -nE 's/^\{"database":"titra","collectionCount":[0-9]+,"documentCount":[0-9]+,"indexCount":([0-9]+),"collections":\[.*$/\1/p' "$database_summary")"
[[ "$summary_collection_count" =~ ^[0-9]+$ && "$summary_document_count" =~ ^[0-9]+$ && "$summary_index_count" =~ ^[0-9]+$ ]] \
  || die 'Production database-summary does not have the exact format-2 schema.'
[[ "$summary_collection_count" == "${BACKUP_VALUES[collection_count]}" \
  && "$summary_document_count" == "${BACKUP_VALUES[document_count]}" \
  && "$summary_index_count" == "${BACKUP_VALUES[index_count]}" ]] \
  || die 'Backup manifest totals disagree with its checksummed database summary.'
require_lab_host_capacity
require_lab_disk_capacity "$archive" "${BACKUP_VALUES[database_total_size_bytes]}"

info 'Starting only the isolated MongoDB service...'
compose up --detach mongodb
wait_for_healthy "$LAB_CONTAINER_DB" mongodb 60
verify_running_container_image "$LAB_CONTAINER_DB" "$MONGO_RUNTIME_IMAGE_ID"
verify_lab_mongo_limits
lab_mongo_version="$(compose exec --no-TTY mongodb mongosh "$LAB_DATABASE" --quiet --eval 'print(db.version())')"
[[ "$lab_mongo_version" == '7.0.40' ]] || die "Unexpected lab MongoDB runtime version: ${lab_mongo_version:-unknown}"
backup_mongo_major_minor="$(awk -F. '{print $1 "." $2}' <<< "${BACKUP_VALUES[mongo_server_version]}")"
lab_mongo_major_minor="$(awk -F. '{print $1 "." $2}' <<< "$lab_mongo_version")"
[[ "$backup_mongo_major_minor" == "$lab_mongo_major_minor" ]] \
  || die "Backup Mongo version ${BACKUP_VALUES[mongo_server_version]} is incompatible with lab Mongo $lab_mongo_version."
verify_production_separation
verify_existing_lab_runtime_isolation
require_lab_frontend_stopped

database_summary_json() {
  local database="$1" reported_database="$2"
  compose exec --no-TTY mongodb mongosh "$database" --quiet --eval \
    "const normalizeIndex = i => ({
      name: i.name,
      key: i.key,
      v: i.v,
      unique: i.unique === true,
      sparse: i.sparse === true,
      hidden: i.hidden === true,
      expireAfterSeconds: i.expireAfterSeconds === undefined ? null : i.expireAfterSeconds,
      partialFilterExpression: i.partialFilterExpression === undefined ? null : i.partialFilterExpression,
      collation: i.collation === undefined ? null : i.collation
    });
    const names = db.getCollectionNames().sort();
    const rows = names.map(name => {
      const indexes = db.getCollection(name).getIndexes().map(normalizeIndex)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {name, documents: db.getCollection(name).countDocuments({}), indexCount: indexes.length, indexes};
    });
    const collectionCount = rows.length;
    const documentCount = rows.reduce((n, row) => n + row.documents, 0);
    const indexCount = rows.reduce((n, row) => n + row.indexCount, 0);
    print(JSON.stringify({database:'$reported_database', collectionCount, documentCount, indexCount, collections:rows}));"
}

drop_lab_database() {
  compose exec --no-TTY mongodb mongosh --quiet --eval \
    "const r=db.getSiblingDB('$LAB_DATABASE').dropDatabase(); if (!r.ok) { throw new Error(JSON.stringify(r)); }" >/dev/null
}

declare -a MONGO_HEAVY_PREFIX=()
configure_mongo_heavy_prefix() {
  MONGO_HEAVY_PREFIX=()
  if compose exec --no-TTY mongodb sh -c 'command -v ionice >/dev/null 2>&1'; then
    MONGO_HEAVY_PREFIX+=(ionice -c 3)
  fi
  if compose exec --no-TTY mongodb sh -c 'command -v nice >/dev/null 2>&1'; then
    MONGO_HEAVY_PREFIX+=(nice -n 10)
  fi
  if (( ${#MONGO_HEAVY_PREFIX[@]} > 0 )); then
    info "Low-priority Mongo tool wrapper: ${MONGO_HEAVY_PREFIX[*]}"
  else
    info 'WARNING: ionice/nice are unavailable in the Mongo image; relying on the verified container CPU/memory limits.' >&2
  fi
}

configure_mongo_heavy_prefix

rollback_archive=''
rollback_summary=''
recover_previous_lab_or_clear() {
  local reason="$1" recovered_summary recovered_hash remaining_collections
  info "Restore safety recovery triggered: $reason" >&2
  if [[ -n "$rollback_archive" ]]; then
    [[ -f "$rollback_archive" && -f "$rollback_summary" ]] \
      || die 'CRITICAL: previous-lab recovery artifacts are missing; the lab app remains stopped.'
    recovered_hash="$(sha256sum -- "$rollback_archive")"
    recovered_hash="${recovered_hash%% *}"
    [[ "$recovered_hash" == "$snapshot_hash" ]] \
      || die 'CRITICAL: previous-lab recovery archive checksum failed; the lab app remains stopped.'
    drop_lab_database \
      || die 'CRITICAL: could not clear the failed incoming clone before previous-lab recovery.'
    if ! compose exec --no-TTY mongodb "${MONGO_HEAVY_PREFIX[@]}" mongorestore --archive --gzip --stopOnError < "$rollback_archive"; then
      die 'CRITICAL: incoming restore failed and restoring the previous isolated lab snapshot also failed.'
    fi
    recovered_summary="$(database_summary_json "$LAB_DATABASE" "$LAB_DATABASE")" \
      || die 'CRITICAL: previous lab was restored but its verification summary could not be generated.'
    [[ "$recovered_summary" == "$(<"$rollback_summary")" ]] \
      || die 'CRITICAL: previous lab snapshot recovery completed but document/index verification FAILED.'
    info 'Previous isolated lab snapshot was restored and its per-collection document/index summary was verified.' >&2
  else
    drop_lab_database \
      || die 'CRITICAL: incoming restore failed and its partial isolated database could not be removed.'
    remaining_collections="$(compose exec --no-TTY mongodb mongosh --quiet --eval "db.getSiblingDB('$LAB_DATABASE').getCollectionNames().length")"
    [[ "$remaining_collections" == '0' ]] \
      || die 'CRITICAL: partial isolated database cleanup could not be verified.'
    info 'No previous lab existed; the partial incoming lab database was removed and verified empty.' >&2
  fi
}

info 'Running a local mongorestore dry run inside the isolated MongoDB container...'
compose exec --no-TTY mongodb mongorestore --help 2>&1 | grep -F -- '--dryRun' >/dev/null \
  || die 'The isolated MongoDB tools do not support mongorestore --dryRun.'
compose exec --no-TTY mongodb "${MONGO_HEAVY_PREFIX[@]}" mongorestore \
  --dryRun \
  --archive --gzip \
  --nsInclude='titra.*' \
  --nsFrom='titra.*' \
  --nsTo="${LAB_DATABASE}.*" \
  --stopOnError < "$archive" >/dev/null \
  || die 'Local dry run rejected the incoming archive; the existing lab database was not changed.'

collection_count="$(compose exec --no-TTY mongodb mongosh --quiet --eval "db.getSiblingDB('$LAB_DATABASE').getCollectionNames().length")"
if [[ "$collection_count" =~ ^[0-9]+$ && "$collection_count" -gt 0 ]]; then
  lab_frontend_is_stopped || die 'Lab ingress or app restarted before the safety snapshot; refusing to continue.'
  snapshot_id="$(date -u +'%Y%m%dT%H%M%SZ')"
  snapshot_dir="$LAB_BACKUP_ROOT/$snapshot_id"
  snapshot_partial="$LAB_BACKUP_ROOT/.$snapshot_id.partial"
  [[ ! -e "$snapshot_dir" && ! -e "$snapshot_partial" ]] || die "Lab snapshot destination already exists: $snapshot_id"
  install -d -o root -g root -m 0700 "$snapshot_partial"
  rollback_archive="$snapshot_dir/titra-lab.archive.gz"
  rollback_summary="$snapshot_dir/database-summary.json"
  info "Saving the current isolated lab database to $snapshot_dir ..."
  database_summary_json "$LAB_DATABASE" "$LAB_DATABASE" > "$snapshot_partial/database-summary.json"
  compose exec --no-TTY mongodb "${MONGO_HEAVY_PREFIX[@]}" mongodump --db "$LAB_DATABASE" --archive --gzip > "$snapshot_partial/titra-lab.archive.gz"
  [[ -s "$snapshot_partial/titra-lab.archive.gz" ]] || die 'The previous-lab recovery archive is empty.'
  snapshot_hash="$(sha256sum -- "$snapshot_partial/titra-lab.archive.gz")"
  snapshot_hash="${snapshot_hash%% *}"
  snapshot_summary_hash="$(sha256sum -- "$snapshot_partial/database-summary.json")"
  snapshot_summary_hash="${snapshot_summary_hash%% *}"
  printf '%s  titra-lab.archive.gz\n' "$snapshot_hash" > "$snapshot_partial/titra-lab.archive.gz.sha256"
  printf 'format_version=1\nsource_database=%s\narchive_format=mongodump-archive-gzip\narchive_file=titra-lab.archive.gz\narchive_sha256=%s\ndatabase_summary_file=database-summary.json\ndatabase_summary_sha256=%s\ncreated_at_utc=%s\n' \
    "$LAB_DATABASE" "$snapshot_hash" "$snapshot_summary_hash" "$snapshot_id" > "$snapshot_partial/manifest.env"
  mv -- "$snapshot_partial" "$snapshot_dir"
fi

info 'Replacing only the isolated lab database...'
lab_frontend_is_stopped || die 'Lab ingress or app restarted before destructive restore; refusing to continue.'
mark_restore_unsafe "$backup_dir" "$actual_hash"
drop_lab_database

if ! compose exec --no-TTY mongodb "${MONGO_HEAVY_PREFIX[@]}" mongorestore \
  --archive --gzip \
  --nsInclude='titra.*' \
  --nsFrom='titra.*' \
  --nsTo="${LAB_DATABASE}.*" \
  --stopOnError < "$archive"; then
  recover_previous_lab_or_clear 'incoming mongorestore returned an error'
  die 'Production backup could not be restored into the isolated lab.'
fi

restored_database_summary="$(database_summary_json "$LAB_DATABASE" titra)" \
  || {
    recover_previous_lab_or_clear 'post-restore database summary could not be generated'
    die 'Incoming clone summary generation failed; previous lab state was recovered or the partial clone was cleared.'
  }
if [[ "$restored_database_summary" != "$expected_database_summary" ]]; then
  recover_previous_lab_or_clear 'per-collection document/index summary did not match the production backup'
  die 'Incoming clone failed exact pre-sanitization document/index verification; previous lab state was recovered or the partial clone was cleared.'
fi

restored_collections="$(compose exec --no-TTY mongodb mongosh --quiet --eval "db.getSiblingDB('$LAB_DATABASE').getCollectionNames().length")"
restored_documents="$(compose exec --no-TTY mongodb mongosh --quiet --eval "print(db.getSiblingDB('$LAB_DATABASE').getCollectionNames().reduce((n,name) => n + db.getSiblingDB('$LAB_DATABASE').getCollection(name).countDocuments({}), 0))")"
restored_indexes="$(compose exec --no-TTY mongodb mongosh --quiet --eval "print(db.getSiblingDB('$LAB_DATABASE').getCollectionNames().reduce((n,name) => n + db.getSiblingDB('$LAB_DATABASE').getCollection(name).getIndexes().length, 0))")"
if [[ "$restored_collections" != "${BACKUP_VALUES[collection_count]}" \
  || "$restored_documents" != "${BACKUP_VALUES[document_count]}" \
  || "$restored_indexes" != "${BACKUP_VALUES[index_count]}" ]]; then
  recover_previous_lab_or_clear 'restored aggregate collection/document/index totals did not match the backup manifest'
  die 'Incoming clone failed manifest total verification; previous lab state was recovered or the partial clone was cleared.'
fi
info 'Exact pre-sanitization per-collection document/index summary matches the checksummed production backup.'

info 'Sanitizing cloned sessions, login services, and integrations...'
if ! sanitize_output="$(compose exec --no-TTY mongodb mongosh --quiet "mongodb://127.0.0.1:27017/$LAB_DATABASE?directConnection=true" /opt/titra-lab/sanitize-clone.js)"; then
  printf '%s\n' "$sanitize_output" >&2
  recover_previous_lab_or_clear 'clone sanitization command failed'
  die 'Clone sanitization failed; previous lab state was recovered or the partial clone was cleared.'
fi
sanitize_summary="$(printf '%s\n' "$sanitize_output" | sed -n 's/^TITRA_LAB_SANITIZE=//p' | tail -n 1)"
if [[ "$sanitize_summary" != \{*\} ]]; then
  recover_previous_lab_or_clear 'clone sanitization did not return its verification record'
  die 'Clone sanitization verification failed; previous lab state was recovered or the partial clone was cleared.'
fi
password_login_count="$(printf '%s\n' "$sanitize_output" | sed -n 's/^TITRA_LAB_PASSWORD_LOGINS=//p' | tail -n 1)"
admin_password_login_count="$(printf '%s\n' "$sanitize_output" | sed -n 's/^TITRA_LAB_ADMIN_PASSWORD_LOGINS=//p' | tail -n 1)"
if [[ ! "$password_login_count" =~ ^[0-9]+$ || ! "$admin_password_login_count" =~ ^[0-9]+$ ]]; then
  recover_previous_lab_or_clear 'clone sanitization did not report usable password-login counts'
  die 'Clone sanitization login verification failed; previous lab state was recovered or the partial clone was cleared.'
fi
if [[ "$password_login_count" == '0' ]]; then
  info 'WARNING: the sanitized clone has zero active users with password login; OIDC/LDAP and external login services are disabled in the lab.' >&2
fi
if [[ "$admin_password_login_count" == '0' ]]; then
  info 'WARNING: the sanitized clone has zero active administrators with password login; the migration wizard will be inaccessible until a lab-only admin login is provisioned.' >&2
fi

restore_id="$(date -u +'%Y%m%dT%H%M%SZ')"
install -d -o root -g root -m 0700 "$STATE_DIR/restores"
receipt_partial_dir="$STATE_DIR/restores/.$restore_id.partial"
receipt_dir="$STATE_DIR/restores/$restore_id"
[[ ! -e "$receipt_partial_dir" && ! -e "$receipt_dir" ]] || die "Restore receipt destination already exists: $restore_id"
install -d -o root -g root -m 0700 "$receipt_partial_dir"
receipt="$receipt_dir/receipt.env"
printf 'format_version=1\nrestored_at_utc=%s\nsource_backup=%s\nsource_archive_sha256=%s\nsource_database_summary_sha256=%s\npre_sanitization_summary_verified=true\ntarget_database=%s\ncollections=%s\ndocuments=%s\nindexes=%s\nusable_password_logins=%s\nusable_admin_password_logins=%s\n' \
  "$restore_id" "$backup_dir" "$actual_hash" "$summary_actual_hash" "$LAB_DATABASE" "$restored_collections" "$restored_documents" "$restored_indexes" \
  "$password_login_count" "$admin_password_login_count" > "$receipt_partial_dir/receipt.env"
printf '%s\n' "$sanitize_summary" > "$receipt_partial_dir/sanitization.json"
mv -- "$receipt_partial_dir" "$receipt_dir"
clear_restore_unsafe_marker
require_lab_safe_to_start

info 'Starting the isolated application and loopback ingress...'
lab_app_starting=true
cleanup_failed_app_start() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ "$rc" -ne 0 && "$lab_app_starting" == 'true' ]]; then
    info 'Lab application start failed; stopping the app and ingress while leaving isolated MongoDB available for inspection.' >&2
    if ! stop_and_verify_lab_frontend; then
      info 'CRITICAL: failed to prove that lab ingress and app are stopped after the application-start failure.' >&2
    fi
  fi
  exit "$rc"
}
trap cleanup_failed_app_start EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose up --detach
verify_lab_runtime_isolation
wait_for_healthy "$LAB_CONTAINER_APP" titra 90
wait_for_healthy "$LAB_CONTAINER_INGRESS" ingress 60
verify_running_container_image "$LAB_CONTAINER_APP" "$TITRA_RUNTIME_IMAGE_ID"
verify_running_container_image "$LAB_CONTAINER_INGRESS" "$TITRA_RUNTIME_IMAGE_ID"
verify_lab_resource_limits

lab_app_starting=false
trap - EXIT INT TERM
info "Restored $restored_collections collections into $LAB_DATABASE."
info "Receipt: $receipt"
info "Open the lab through an SSH tunnel at http://localhost:$LAB_PORT"
