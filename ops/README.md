# Operator service template

`recourse-operator.service` is an uninstalled, read-only-by-default systemd
template for a dedicated `recourse` service account on a genuinely separate
operator host. The existing shared Recourse web VPS does not satisfy this
boundary and must not be treated as the execution host. Its release tree is isolated
at `/opt/recourse-operator`; `/opt/recourse` remains reserved for the static web
release. The unit reads:

- code and `deployments-horizon1.json` through
  `/opt/recourse-operator/current`;
- non-secret policy configuration from `/etc/recourse/operator.json`;
- public read-only RPC URLs from
  `/etc/recourse/operator-runtime.conf`; and
- writable Horizon 1 cursors, reports, status, and journals from
  `/var/lib/recourse-operator`; and
- V3 state from
  `/var/lib/recourse-operator/v3-pilot-activation/<activation-config-commitment>`.

For V3, install the reviewed `daemon/operator-config-v3.example.json` as
`/etc/recourse/operator.json`. It explicitly selects `activation-v3.json`; the
daemon rejects allowlists that do not exactly match that activated facility,
policy, asset, and source-chain set. It also requires the fixed
`generation-activation-commitment-v1` state layout, so a V3 activation cannot
consume or overwrite Horizon 1 state and a later activation preserves the prior
activation's recovery journals.

The runtime configuration file must contain only public URLs. Do not put private
keys, bearer tokens, account credentials, or provider secrets in it.

## Fresh V3 core-manifest handoff

Freeze deployment artifacts with Forge 1.7.1 by running `forge build --force`
and `npm run build:usc-contracts-020` before reviewing either activation
configuration. The checked-in V3 and USC
configurations pin the exact raw artifact files, and the root Node suite rejects
every stale non-placeholder pin. Any source or toolchain change requires a fresh
forced build, review, and hash update before approval.

`deployments-v3.json` is the immutable historical V3 record. It predates the
current hardened contracts, and the deployment reservation correctly refuses to
overwrite it. Never remove, rename, or replace that file to make a broadcast
proceed.

Use a new manifest filename for the reviewed current build. Keep that exact
filename through every stage of the deployment qualification:

```sh
# Offline default: no RPC, signer, file write, or broadcast.
npm run deploy:v3 -- --manifest deployments-v3-current.json

# Signerless live qualification and fee construction; still no file write.
npm run deploy:v3 -- \
  --manifest deployments-v3-current.json \
  --live-check

# Write the exact live plan to a new, access-controlled file for review.
npm run deploy:v3 -- \
  --manifest deployments-v3-current.json \
  --live-check \
  --write-plan /secure/path/v3-deployment-plan.json
```

The live plan commits the clean deployable source scope at the exact Git commit,
all six pinned raw artifacts, the live anchor, predicted addresses, nonces,
calldata, values, and capped fee fields. Its transaction sequence is exactly six
transactions: five contract creations (`PolicyKernelV2`, `PolicyRegistryV1`,
`CappedPilotFactoryV1`, `MultiChainEventPolicyV1`, and `ProofJobsV1`) followed
by the one-time `PolicyKernelV2.setProofJobs` call. The sixth pinned artifact is
`VerifiedCreditStateV1`, which the kernel creates from its constructor.

The plan expires 30 minutes after its chain timestamp. Treat the written file as
a review candidate until an accountable human separately approves that exact
plan and its fee ceilings. Do not edit or regenerate an approved file. While it
is still valid, broadcast only by supplying that exact file:

```sh
npm run deploy:v3 -- \
  --manifest deployments-v3-current.json \
  --live-check \
  --broadcast \
  --approved-plan /secure/path/v3-deployment-plan.json
```

Broadcast mode loads the signer only after approval validation and requalifies
the chain state before signing and broadcasting. Before each broadcast it
durably persists the exact raw signed transaction in
`deployments-v3-current.json.v3-deployment-journal.json`. Recovery checks for
that transaction first and can rebroadcast only the same raw bytes; nonce
advancement or a different transaction is an incident. Each step must reach the
configured confirmation depth and pass canonical transaction, receipt, block,
and block-hash checks before the journal advances.

Preserve the manifest-specific `.v3-deployment-journal.json` throughout
recovery. Do not delete or edit it to restart from another nonce. The `.lock` is
process ownership rather than recovery state; the tool may recover it only when
its recorded PID is demonstrably dead. If the 30-minute approval expires after
partial progress, rerun `--live-check --write-plan` with a new plan filename.
The resulting renewal is bound to the existing journal checkpoint and exact
remaining steps and requires a fresh separate human approval.

Only after all six transactions are canonical does the command verify the exact
deployed runtimes around compiler immutables for all six pinned artifacts,
including `VerifiedCreditStateV1`, and atomically write the evidence-complete
manifest. The manifest binds source, configuration, artifacts, constructor
arguments, approved execution plan, canonical transaction and block evidence,
confirmation policy, runtime hashes, and the final verification block. Then
hash it for the activation handoff:

```sh
sha256sum deployments-v3-current.json
```

After the deployment has completed and qualified, copy
`config/v3-pilot-cc3.json` to a reviewed activation-specific config. Set
`coreManifest.path` to exactly `deployments-v3-current.json` and set
`coreManifest.sha256` to the lowercase digest printed above. Activation rejects
either a path or byte mismatch. The activation config additionally pins the
current `CappedPilotFactoryV1` artifact; live preflight, journal recovery, and
final qualification compare its executable runtime around every immutable, and
final qualification applies the same check to the created
`RecourseFacilityV3`. Exact factory getter checks bind all constructor values,
so a stale factory that creates an older facility cannot qualify. Verify the
handoff offline before any live check:

```sh
npm run activate:v3 -- --help
npm run activate:v3 -- \
  --config config/v3-pilot-cc3-current.json \
  --core-manifest deployments-v3-current.json
```

Then use those exact two arguments for `--live-check --write-plan`; after the
resulting file and fee ceilings receive explicit human approval, use them again
with `--live-check --broadcast --approved-plan`. Do not activate against the
checked-in historical manifest, and do not substitute a manifest after the plan
has been reviewed.

## Separate V3 extension manifests

Deploy closed loop, the operator market, and portfolio core separately from the
fresh six-contract V3 core. Each generation gets its own reviewed config,
approval file, manifest filename, and recovery journal. Start from exactly one
of `config/v3-closed-loop.example.json`,
`config/v3-operator-market.example.json`, or
`config/v3-portfolio-core.example.json`; none is authorized as checked in.

Replace every placeholder with reviewed evidence, including exact prerequisite
manifest paths and lowercase SHA-256 digests. Closed loop requires both the
fresh V3-core manifest and a qualified USC-remedy manifest. The market requires
an independently qualified service-verifier manifest and pinned token runtime.
Portfolio core requires the fresh V3-core manifest plus approved manager,
borrower, guardian, registry-release, evidence-kind, adapter-kind, deadline,
limit, fee, and pinned asset-runtime decisions. Its predicted pool address must
also have a zero asset balance before deployment. Do not invent any of these
values or pre-fund a predicted address.

Use a new manifest filename and preserve it through every mode:

```sh
# Offline validation and deterministic planning; no RPC or signer.
npm run deploy:v3-extension -- \
  --config /secure/path/reviewed-extension.json \
  --manifest deployments-v3-extension-current.json

# Signerless qualification and a new 30-minute approval candidate.
npm run deploy:v3-extension -- \
  --config /secure/path/reviewed-extension.json \
  --manifest deployments-v3-extension-current.json \
  --live-check \
  --write-plan /secure/path/v3-extension-plan.json

# Only after separate human approval of that exact file.
npm run deploy:v3-extension -- \
  --config /secure/path/reviewed-extension.json \
  --manifest deployments-v3-extension-current.json \
  --live-check \
  --broadcast \
  --approved-plan /secure/path/v3-extension-plan.json
```

The approved envelope binds its full issue/expiry window, live qualification,
prerequisite hashes, ordered nonces, constructor data, and total fee ceiling.
The command checks the canonical approval anchor before each first broadcast and
writes the exact raw signed transaction to the manifest-specific journal before
sending it. Do not edit or delete the journal during recovery; only the same raw
bytes may be rebroadcast. After completion, requalify without a signer:

```sh
npm run deploy:v3-extension -- \
  --config /secure/path/reviewed-extension.json \
  --manifest deployments-v3-extension-current.json \
  --live-check \
  --qualify-deployed
```

Keep separate filenames for all three generations. A manifest for one
generation cannot satisfy another generation's prerequisite or authorization
boundary.

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
  'const c=require("/etc/recourse/operator.json"),m=require("/opt/recourse-operator/current/"+c.deploymentManifest),p=m.generation==="v3-pilot-activation"?"/var/lib/recourse-operator/v3-pilot-activation/"+m.configCommitment.slice(2)+"/status.json":"/var/lib/recourse-operator/status.json",s=require(p);if(s.mode!=="read-only"||s.lifecycle!=="running"||s.healthy!==true||s.lastSuccessAt===null||s.lastError!==null)process.exit(1)'
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

Preserve the entire `/var/lib/recourse-operator` tree during rollback so Horizon
1 and every activation-specific V3 namespace remain available and no cursor or
journal is silently discarded. If the previous release cannot read its matching
namespace, leave the service stopped and restore the matching encrypted backup
rather than deleting or rewriting state.

## Signer credential and recovery rehearsal

Keep the base unit read-only and free of signing material. On the separately
provisioned execution host, install the hunter key as a root-owned mode `0600`
file outside the release and environment files, then add a reviewed systemd
drop-in:

```ini
[Service]
LoadCredential=recourse-hunter-private-key:/etc/recourse/operator-hunter.key
```

systemd exposes that file through `CREDENTIALS_DIRECTORY`; the V3 runner uses it
before the development-only `HUNTER_PRIVATE_KEY` fallback. Never define both in
production. Run `systemd-analyze verify` against the unit and drop-in on the
target host before any start.

Before execution is authorized, stop the service at a durable boundary and
create an authenticated encrypted backup of all of
`/var/lib/recourse-operator`. Restore it on a disposable host with networking
disabled. Do not install a signer credential, do not define RPC variables, and
do not start `operator.mjs`, `v3.mjs`, or any recovery command: recovery-only
execution may still reconcile and broadcast a previously signed pending
transaction.

Validate the restored backup offline by checking its authenticated file
inventory and digest, parsing every JSON file, comparing the release and
activation-manifest digests with the recorded values, and verifying the
expected owner and mode without modifying any journal. Record those results and
the operator acknowledgement. This proves backup integrity and restorability;
it does not prove live transaction reconciliation. Any live reconciliation
rehearsal is a separate transaction-authorized operation with the same broadcast
risk as normal recovery. An unrehearsed backup is not a recovery control. Never
copy a live journal while the service is writing it, and never delete a pending
signed transaction journal to force a restart.

## Execution remains gated

This unit is configured only for read-only qualification. Do not change
`execution` to `enabled` or add signing material to
`operator-runtime.conf`. Executable operation requires a separately reviewed V3
deployment and runtime, independent contract audit, live transport
qualification, exact allowlists and conservative economics, an exclusively held
signer, adequate CC3 funding, separate-host provisioning and review, a completed
encrypted-backup restore rehearsal, and explicit human authorization. The
execution kernel must also report
`safeStaleProofRelease() == true`; PolicyKernelV1 and unknown kernels fail
closed.

The data directory contains proof salts and signed raw transactions while a
commit/reveal lifecycle is in progress. It must remain mode `0700`, must not be
served by a web server, and must be included in an encrypted operational backup.
The daemon fsyncs each journal file before rename and, on Linux, fsyncs the parent
directory after rename. Other platforms rely on their atomic rename semantics.
The actual power-loss guarantee still depends on the host filesystem and storage
configuration.
