# Integration and compatibility notes

The package has two pre-deployment probes that run without exporting document
contents: a stored-data compatibility count and a personal-task-suggestion
configuration check. Warning counts require an attended acknowledgement; raw
probe output remains in root-only diagnostics.

The isolated lab uses a sanitized clone, an internal database network, a
loopback-only ingress proxy, fixed resource limits, and no registry pull. It is
intended to exercise the exact packaged images before a production cutover.

Application-specific security settings are passed only to the candidate release.
Predecessor transitions and rollback omit settings that older images do not
understand. The OAuth sealing key is generated once in a root-only runtime file
and retained across package replacement and rollback.

These scripts verify operational invariants; they do not replace application
unit/integration tests, an external backup policy, or a review of the deployment
environment.
