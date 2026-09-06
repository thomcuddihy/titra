#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TITRA_LAB_LOCK_MODE='exclusive'
# shellcheck source=lock-bootstrap.sh
source "$SCRIPT_DIR/lock-bootstrap.sh"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

prepare_operation exclusive

info 'Stopping the isolated Titra lab. Its MongoDB volume will be preserved.'
compose down --remove-orphans
info "Preserved volume: $LAB_VOLUME"
