# Operator service template

`recourse-operator.service` is an uninstalled systemd template for a dedicated
`recourse` service account. It expects the repository at `/opt/recourse`,
non-secret configuration at `/etc/recourse/operator.json`, secrets and RPC URLs
in `/etc/recourse/operator.env`, and writable state at
`/var/lib/recourse-operator`.

Keep `execution` set to `read-only` during qualification. Enabling execution is
an explicit operator decision and still requires the exact facility, policy,
asset, and source-chain allowlists, conservative economic bounds, an exclusive
signer, and a PolicyKernelV2 that reports `safeStaleProofRelease() == true`.
PolicyKernelV1 and unknown kernels fail closed. The checked-in service file does
not install, enable, start, deploy, or fund anything.

The data directory contains proof salts and signed raw transactions while a
commit/reveal lifecycle is in progress. It must remain mode `0700`, must not be
served by a web server, and must be included in an encrypted operational backup.
The daemon fsyncs each journal file before rename and, on Linux, fsyncs the parent
directory after rename. Other platforms rely on their atomic rename semantics.
The actual power-loss guarantee still depends on the host filesystem and storage
configuration.
