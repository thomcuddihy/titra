#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
export PYTHONDONTWRITEBYTECODE=1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node_bin=${NODE_BIN:-node}
if [[ $node_bin == */* ]]; then
  node_exec=$node_bin
else
  node_exec=$(type -P -- "$node_bin") || {
    printf 'ERROR: Node executable is unavailable: %s\n' "$node_bin" >&2
    exit 1
  }
fi

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find "$SCRIPT_DIR" -type f \( -name '*.sh' -o -name '*.sh.in' \) -print0)

node_tests=(
  "${SCRIPT_DIR}/tests/source-sanitization.test.mjs"
  "${SCRIPT_DIR}/tests/mongo-archive-builder.test.mjs"
)
if [[ ${node_exec,,} == *.exe ]]; then
  command -v wslpath >/dev/null 2>&1 || {
    printf 'ERROR: Windows Node requires wslpath.\n' >&2
    exit 1
  }
  for node_test in "${node_tests[@]}"; do
    "$node_exec" "$(wslpath -w -- "$node_test")"
  done
else
  "$node_exec" --test "${node_tests[@]}"
fi

NODE_BIN=$node_exec "${SCRIPT_DIR}/tests/release-builder-integration.sh"
printf 'Complete deployment-operations test suite passed.\n'
