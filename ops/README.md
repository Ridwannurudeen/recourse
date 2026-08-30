# Operator service template

`recourse-operator.service` is an uninstalled, read-only-by-default systemd
template for a dedicated `recourse` service account. Its release tree is isolated
at `/opt/recourse-operator`; `/opt/recourse` remains reserved for the static web
release. The unit reads:

- code and `deployments-horizon1.json` through
  `/opt/recourse-operator/current`;
- non-secret policy configuration from `/etc/recourse/operator.json`;
- public read-only RPC URLs from
  `/etc/recourse/operator-runtime.conf`; and
- writable cursors, reports, status, and journals from
  `/var/lib/recourse-operator`.

The runtime configuration file must contain only public URLs. Do not put private
keys, bearer tokens, account credentials, or provider secrets in it.

## Provision a read-only release

Set `RELEASE_SHA` to the exact commit that passed the full test suite, and stage
that source tree at `/tmp/recourse-operator-release` on the host. Build the
artifact with `git archive` so ignored state and local environment files cannot
enter the release. Then run:

```sh
test -n "$RELEASE_SHA"
test -f /tmp/recourse-operator-release/daemon/operator.mjs
test -f /tmp/recourse-operator-release/deployments-horizon1.json
test -f /tmp/recourse-operator-release/daemon/operator-config.example.json
test ! -e "/opt/recourse-operator/releases/$RELEASE_SHA"

sudo useradd --system --home-dir /var/lib/recourse-operator \
  --shell /usr/sbin/nologin recourse 2>/dev/null || \
  test "$(id -u recourse)" -ge 0
sudo install -d -o root -g root -m 0755 \
  /opt/recourse-operator /opt/recourse-operator/releases
sudo install -d -o root -g recourse -m 0750 /etc/recourse
sudo install -d -o recourse -g recourse -m 0700 \
  /var/lib/recourse-operator
sudo cp -a /tmp/recourse-operator-release \
  "/opt/recourse-operator/releases/$RELEASE_SHA"
sudo npm --prefix "/opt/recourse-operator/releases/$RELEASE_SHA" \
  ci --omit=dev
sudo chown -R root:root "/opt/recourse-operator/releases/$RELEASE_SHA"
sudo chmod -R a+rX,go-w "/opt/recourse-operator/releases/$RELEASE_SHA"
sudo install -o root -g recourse -m 0640 \
  "/opt/recourse-operator/releases/$RELEASE_SHA/daemon/operator-config.example.json" \
  /etc/recourse/operator.json
```

Verify that `/etc/recourse/operator.json` still has `execution` set to
`read-only` and that its exact facility, policy, token, source-chain, and economic
bounds are approved for observation. Create
`/etc/recourse/operator-runtime.conf` with only these two assignments:

```text
CREDITCOIN_RPC_URL=https://rpc.cc3-testnet.creditcoin.network
ETH_MAINNET_RPC_URL=https://eth.drpc.org
```

The primary endpoint above and the verified fallback
`https://rpc.flashbots.net` both served the operator's exact five historical
`eth_getLogs` chunks during VPS qualification. Re-probe the configured endpoint
before each release because public RPC capabilities can change. Install the file
as `root:recourse` mode `0640`, then activate the immutable release symlink and
unit:

```sh
sudo chown root:recourse /etc/recourse/operator-runtime.conf
sudo chmod 0640 /etc/recourse/operator-runtime.conf
sudo -u recourse /usr/bin/node -e \
  'const c=require("/etc/recourse/operator.json");if(c.execution!=="read-only")process.exit(1)'
sudo ln -sfn "releases/$RELEASE_SHA" /opt/recourse-operator/next
sudo mv -Tf /opt/recourse-operator/next /opt/recourse-operator/current
sudo install -o root -g root -m 0644 \
  /opt/recourse-operator/current/ops/recourse-operator.service \
  /etc/systemd/system/recourse-operator.service
sudo systemd-analyze verify /etc/systemd/system/recourse-operator.service
sudo -u recourse /usr/bin/node --check \
  /opt/recourse-operator/current/daemon/operator.mjs
sudo systemctl daemon-reload
```

Do not enable the service yet. Start it for qualification, allow at least one
complete discovery and source scan, and require a healthy read-only status:

```sh
sudo systemctl start recourse-operator.service
sudo systemctl status --no-pager recourse-operator.service
sudo journalctl -u recourse-operator.service --since=-10min --no-pager
sudo -u recourse /usr/bin/node -e \
  'const s=require("/var/lib/recourse-operator/status.json");if(s.mode!=="read-only"||s.lifecycle!=="running"||s.healthy!==true||s.lastSuccessAt===null||s.lastError!==null)process.exit(1)'
```

Only after those checks pass may the read-only service be enabled across boots:

```sh
sudo systemctl enable recourse-operator.service
sudo systemctl is-enabled recourse-operator.service
sudo systemctl is-active recourse-operator.service
```

## Roll back

Keep the prior release directory. If qualification fails, point `current` back
to its exact release and restart:

```sh
sudo systemctl stop recourse-operator.service
sudo ln -sfn "releases/<previous-tested-commit>" \
  /opt/recourse-operator/next
sudo mv -Tf /opt/recourse-operator/next /opt/recourse-operator/current
sudo systemctl start recourse-operator.service
sudo systemctl status --no-pager recourse-operator.service
```

Preserve `/var/lib/recourse-operator` during rollback so cursors and journals are
not silently discarded. If the previous release cannot read the current state,
leave the service stopped and restore the matching encrypted backup rather than
deleting or rewriting state.

## Execution remains gated

This unit is configured only for read-only qualification. Do not change
`execution` to `enabled` or add signing material to
`operator-runtime.conf`. Executable operation requires a separately reviewed V3
deployment and runtime, independent contract audit, live transport
qualification, exact allowlists and conservative economics, an exclusively held
signer, adequate CC3 funding, dedicated VPS provisioning and review, and
explicit human authorization. The execution kernel must also report
`safeStaleProofRelease() == true`; PolicyKernelV1 and unknown kernels fail
closed.

The data directory contains proof salts and signed raw transactions while a
commit/reveal lifecycle is in progress. It must remain mode `0700`, must not be
served by a web server, and must be included in an encrypted operational backup.
The daemon fsyncs each journal file before rename and, on Linux, fsyncs the parent
directory after rename. Other platforms rely on their atomic rename semantics.
The actual power-loss guarantee still depends on the host filesystem and storage
configuration.
