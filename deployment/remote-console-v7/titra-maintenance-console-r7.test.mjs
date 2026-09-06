import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./titra-maintenance-console-r7.sh.in', import.meta.url), 'utf8')

test('console is host/path pinned and root only', () => {
  assert.match(source, /\[\[ \$\{EUID\} -eq 0 \]\]/)
  assert.match(source, /EXPECTED_HOST_FQDN='__V7_EXPECTED_HOST_FQDN__'/)
  assert.match(source, /CONSOLE_INSTALL_DIR='__V7_CONSOLE_INSTALL_DIR__'/)
  assert.match(source, /CONSOLE_INSTALL_PATH="\$\{CONSOLE_INSTALL_DIR\}\/console\.sh"/)
  assert.match(source, /stat -c '%u:%g:%a:%h'.*'0:0:700:1'/s)
})

test('console paths are templates and sessions serialize on one lock', () => {
  assert.match(source, /CONSOLE_INSTALL_DIR='__V7_CONSOLE_INSTALL_DIR__'/)
  assert.match(source, /CONSOLE_RUN_DIR='__V7_STATE_ROOT__\/run\/console-r7'/)
  assert.match(source, /CONSOLE_LOCK="\$\{CONSOLE_RUN_DIR\}\/console\.lock"/)
})

test('console serializes sessions and binds protected audit descriptor', () => {
  assert.match(source, /flock --exclusive --nonblock 9/)
  assert.match(source, /exec 8>>"\$audit_log"/)
  assert.match(source, /audit_fd_identity.*\/proc\/\$\{BASHPID\}\/fd\/8/s)
  assert.match(source, /AUDIT_ROOT="\$\{STATE_ROOT\}\/logs-v7\/interactive-console"/)
  assert.match(source, /unexpected_failure_line=/)
})

test('incoming release is pinned, quarantined, and exhaustively verified', () => {
  assert.match(source, /readonly INCOMING_DIR='__V7_INCOMING_DIR__'/)
  assert.match(source, /dd if="\$BUNDLE" of="\$trusted_bundle_partial"/)
  assert.match(source, /verify_quarantined_bundle_contents "\$trusted_bundle"/)
  assert.match(source, /require_quarantine_capacity/)
  assert.match(source, /sha256sum --check --strict SHA256SUMS/)
  assert.doesNotMatch(source, /tar --(?:list|extract)[^\n]*"\$BUNDLE"/)
})

test('mutating children always use a preview-emitted exact confirmation', () => {
  assert.match(source, /run_preview_then_confirm\(\)/)
  assert.match(source, /phrase=\$\(sed -n "s\/\^\$\{required_prefix\}: \/\/p"/)
  assert.match(source, /\[\[ \$reply == "\$phrase" \]\]/)
  assert.match(source, /Required deployment confirmation/)
  assert.match(source, /Required rollback confirmation/)
})

test('console offers all requested transitions through target selection', () => {
  assert.match(source, /predecessor, candidate, and MongoDB images/)
  assert.match(source, /Deployment target \(v6 or v7\)/)
  assert.match(source, /Preview a supported deployment path/)
  assert.match(source, /Deploy v6 or v7 through a supported path/)
  assert.match(source, /Full rollback \(source application and predeployment database\)/)
})

test('console offers secure runtime inspection and private-host configuration', () => {
  assert.match(source, /Show v7 runtime security configuration/)
  assert.match(source, /Configure exact private integration hosts/)
  assert.match(source, /configure-v7-runtime\.sh/)
  assert.doesNotMatch(source, /TITRA_ENABLE_FIRST_USER_ADMIN=true|TITRA_ENABLE_ADMIN_RECOVERY=true/)
})

test('support instructions default to sanitized logs only', () => {
  assert.match(source, /Share only a sanitized support\.log by default/)
  assert.match(source, /Do not copy diagnostic\.log, database manifests, or Compose material without review/)
})
