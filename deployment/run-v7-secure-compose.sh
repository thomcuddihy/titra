#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
project_dir=$(CDPATH='' cd -- "${script_dir}/.." && pwd -P)
compose_file="${project_dir}/docker-compose.v7-secure.yml"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

valid_digest_reference() {
    printf '%s\n' "$1" \
        | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
}

[ -n "${TITRA_IMAGE:-}" ] || die 'TITRA_IMAGE is required.'
valid_digest_reference "$TITRA_IMAGE" \
    || die 'TITRA_IMAGE must be a canonical immutable repository@sha256 reference.'

mongo_image=${MONGO_IMAGE:-mongo:7.0.40@sha256:b6421fd6d1c5ded6377b397d8983e2f82e2100dc5123332dcfda2065a472be5b}
valid_digest_reference "$mongo_image" \
    || die 'MONGO_IMAGE must be a canonical immutable repository@sha256 reference.'

case "${ROOT_URL:-}" in
    https://?*) ;;
    *) die 'ROOT_URL must be an explicit nonempty HTTPS URL.' ;;
esac
printf '%s' "$ROOT_URL" | grep -Eq '^[^[:space:][:cntrl:]]+$' \
    || die 'ROOT_URL contains whitespace or a control character.'

case "${TITRA_BIND_PORT:-3000}" in
    ''|*[!0-9]*) die 'TITRA_BIND_PORT must be an integer from 1 to 65535.' ;;
esac
[ "${TITRA_BIND_PORT:-3000}" -ge 1 ] 2>/dev/null \
    && [ "${TITRA_BIND_PORT:-3000}" -le 65535 ] 2>/dev/null \
    || die 'TITRA_BIND_PORT must be an integer from 1 to 65535.'

secrets_file=${TITRA_SECRETS_FILE:-${project_dir}/titra-v7-secrets.env}
[ -f "$secrets_file" ] && [ ! -L "$secrets_file" ] \
    || die "Secrets file is absent, not regular, or is a symbolic link: ${secrets_file}"
secrets_owner=$(stat -c '%u' -- "$secrets_file")
secrets_mode=$(stat -c '%a' -- "$secrets_file")
[ "$secrets_owner" = "0" ] || die 'The secrets file must be owned by root.'
case "$secrets_mode" in
    400|600) ;;
    *) die 'The secrets file mode must be 0400 or 0600.' ;;
esac

export MONGO_IMAGE="$mongo_image"
export TITRA_SECRETS_FILE="$secrets_file"
exec docker compose --file "$compose_file" "$@"
