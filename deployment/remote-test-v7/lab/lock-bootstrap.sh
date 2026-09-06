#!/bin/bash

# Acquire the package-wide operator lock before sourcing the larger lab library
# or reading the release manifest. The root installer and production tools use
# this exact lock path, preventing mixed-package reads during installation.
set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
umask 077

unset CDPATH ENV BASH_ENV COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
unset COMPOSE_ENV_FILES COMPOSE_PROFILES DOCKER_CONTEXT
export DOCKER_HOST='unix:///var/run/docker.sock'

bootstrap_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" == '0' ]] || bootstrap_die 'Run this command as root.'
case "${TITRA_LAB_LOCK_MODE:-}" in
  exclusive|shared)
    ;;
  *)
    bootstrap_die 'TITRA_LAB_LOCK_MODE must be exclusive or shared.'
    ;;
esac

TITRA_OPERATOR_LOCK_DIR='__V7_LOCK_DIR__'
TITRA_OPERATOR_LOCK_FILE="$TITRA_OPERATOR_LOCK_DIR/operator.lock"
[[ -d /run && ! -L /run ]] || bootstrap_die '/run is unavailable or unsafe.'
[[ ! -L "$TITRA_OPERATOR_LOCK_DIR" ]] || bootstrap_die "Lock directory must not be a symlink: $TITRA_OPERATOR_LOCK_DIR"
if [[ ! -e "$TITRA_OPERATOR_LOCK_DIR" ]]; then
  install -d -o root -g root -m 0700 -- "$TITRA_OPERATOR_LOCK_DIR"
fi
[[ -d "$TITRA_OPERATOR_LOCK_DIR" && ! -L "$TITRA_OPERATOR_LOCK_DIR" ]] \
  || bootstrap_die "Lock directory is not a direct directory: $TITRA_OPERATOR_LOCK_DIR"
IFS=' ' read -r lock_owner lock_mode < <(stat -Lc '%u %a' -- "$TITRA_OPERATOR_LOCK_DIR")
[[ "$lock_owner" == '0' && "$lock_mode" == '700' ]] \
  || bootstrap_die "Lock directory must be root-owned mode 0700: $TITRA_OPERATOR_LOCK_DIR"

[[ ! -L "$TITRA_OPERATOR_LOCK_FILE" ]] || bootstrap_die "Lock path must not be a symlink: $TITRA_OPERATOR_LOCK_FILE"
if [[ ! -e "$TITRA_OPERATOR_LOCK_FILE" ]]; then
  (umask 077; : > "$TITRA_OPERATOR_LOCK_FILE")
fi
[[ -f "$TITRA_OPERATOR_LOCK_FILE" && ! -L "$TITRA_OPERATOR_LOCK_FILE" ]] \
  || bootstrap_die "Lock path is not a direct regular file: $TITRA_OPERATOR_LOCK_FILE"
chown root:root -- "$TITRA_OPERATOR_LOCK_FILE"
chmod 0600 -- "$TITRA_OPERATOR_LOCK_FILE"
IFS=' ' read -r lock_owner lock_mode lock_links < <(stat -Lc '%u %a %h' -- "$TITRA_OPERATOR_LOCK_FILE")
[[ "$lock_owner" == '0' && "$lock_mode" == '600' && "$lock_links" == '1' ]] \
  || bootstrap_die "Operator lock file must be root-owned mode 0600 with one link: $TITRA_OPERATOR_LOCK_FILE"

exec 9<>"$TITRA_OPERATOR_LOCK_FILE"
if [[ "$TITRA_LAB_LOCK_MODE" == 'shared' ]]; then
  flock --shared --nonblock 9 || bootstrap_die "Another Titra operator task holds $TITRA_OPERATOR_LOCK_FILE."
else
  flock --exclusive --nonblock 9 || bootstrap_die "Another Titra operator task holds $TITRA_OPERATOR_LOCK_FILE."
fi
TITRA_LAB_LOCK_HELD="$TITRA_LAB_LOCK_MODE"
readonly TITRA_OPERATOR_LOCK_DIR TITRA_OPERATOR_LOCK_FILE TITRA_LAB_LOCK_HELD
