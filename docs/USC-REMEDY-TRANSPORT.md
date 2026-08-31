# USC remedy transport

`UscRemedyTransportV1` and `UscRemedyDispatcherV1` are an undeployed, single-route adapter for the
USC contracts package pinned by this repository. They do not establish that a USC route is live,
funded, audited, or authorized.

## Fixed trust path

The source adapter is immutable to one `RemedyCoordinatorV1`, one `IOutbox`, one ATTEST token, one
destination chain key, one `BoundedRemedyReceiverV1`, and one nonzero maximum core fee. Only the
coordinator can publish. The adapter requires the coordinator's destination chain, receiver, intent
ID, and expiry to match the fixed route and the canonical remedy payload. It publishes an
acknowledgment-enabled USC envelope containing the destination receiver, source coordinator, and
complete remedy payload.

The destination dispatcher is immutable to one Inbox, source chain ID, source adapter, source
coordinator, and bounded receiver. It rejects every other Inbox, source domain, emitter, coordinator,
or receiver. Its `setTrustedInbox` implementation always reverts because the trusted Inbox cannot be
changed. The bounded receiver must be constructed with the dispatcher as its `transport`; otherwise
delivery reverts at `BoundedRemedyReceiverV1.NotTransport`.

The dispatcher marks a message before calling the bounded receiver. A receiver or target revert
reverts that mark as well, allowing the USC Inbox to retain the message and retry the same message ID.
A successful delivery is protected by replay guards in both the dispatcher and bounded receiver.

## Offline planning, deployment order, and recovery

`config/usc-remedy.example.json` contains deliberate route placeholders and cannot authorize a deployment.
Run `npm run build:usc-contracts-020` to compile the pinned package's exact Inbox source against its
own pinned OpenZeppelin dependency, then copy the example to a private working location and replace
every route, bytecode, owner, validator, registry, attestor, nonce, and fee field with independently
reviewed evidence. The planner pins USC contracts version `0.2.0` and computes five nonce-bound
creations in this order: source transport,
source coordinator, destination receiver, destination dispatcher, and the dedicated destination Inbox.
The Inbox is deployed last with its constructor bound to the predicted dispatcher. The tool never
calls `setMessageDispatcher` and never replaces a shared Inbox dispatcher.

Use one exact private config and manifest through every phase:

```text
npm run deploy:usc-remedy -- --config /private/usc.json --manifest /private/usc-deployment.json
npm run deploy:usc-remedy -- --config /private/usc.json --manifest /private/usc-deployment.json --live-check --write-plan /private/usc-plan.json
npm run deploy:usc-remedy -- --config /private/usc.json --manifest /private/usc-deployment.json --live-check --broadcast --approved-plan /private/usc-plan.json
npm run deploy:usc-remedy -- --config /private/usc.json --manifest /private/usc-deployment.json --qualify-deployed
```

The first command is offline and does not load an RPC, signer, write a file, or broadcast. The live
plan is expiring and binds current nonces, predicted addresses, exact calls, gas limits, fee fields,
and total native-fee ceilings. Broadcast rechecks approval and mutable route safety immediately before
the first send. Every signed transaction is persisted before broadcast and reconciled after restart;
an uncertain nonce is an incident, never permission to create a replacement transaction. Final
read-only qualification verifies the deployed transactions, runtime code, immutable bindings, mutable
trust state, dedicated topology, and pause/fee state. Deployment is incomplete until that qualification
passes.

## Required deployment evidence

Before deployment, the accountable operator must independently verify all of the following against
the intended networks:

- The source Outbox address is the official USC Outbox for the destination chain key. The installed
  `IOutbox` has no official-route registry, so constructor checks can verify `chainKey()` but cannot
  prove that an address is official. Verify its deployed bytecode and configured owner, validator,
  FeeRegistry, AttestorVault, ATTEST token, rate limit, and pause state against the USC deployment
  authority.
- The destination Inbox is the official Inbox for the source Creditcoin chain and is configured to
  call the new dispatcher. Verify its deployed bytecode, `creditcoinChainId`, vote validator, owner,
  and pause state.
- The source and destination chain identifiers use the exact USC route identifiers. The adapter
  requires the destination value to equal `Outbox.chainKey()` and the dispatcher requires the Inbox
  callback's source chain ID to equal its immutable source chain.
- The immutable `maximumCoreFee` is an explicitly approved ATTEST-denominated ceiling supported by
  current route evidence and operating budget. A later FeeRegistry increase does not expand that
  authorization.
- The source adapter address used by the dispatcher and the dispatcher address trusted by the bounded
  receiver are exact. Because the dispatcher and receiver bind each other, precompute one deployment
  address or use a reviewed deterministic deployment. Verify the deployed addresses and immutable
  values before authorizing any remedy.
- The guardian has authorized the exact tuple consumed by `BoundedRemedyReceiverV1`: source chain,
  source coordinator, intent ID, target, action kind, action-data hash, and expiry. The target must
  implement `IRemedyTargetV1`, enforce its own bounded action, and return a nonzero result digest.
- Independent contract and operational review covers the exact commit, compiler settings, deployed
  bytecode, USC dependency version, route configuration, target behavior, signer custody, monitoring,
  and incident procedure.

## Funding and acknowledgment

Transfer ATTEST directly to the source adapter only after the route is verified and the exact publish
is authorized. Each publish reads the Outbox's live `coreFee()`, gives that Outbox an allowance of
exactly that amount, publishes with acknowledgment requested, and resets the allowance to zero. It
reverts before approval or publication when the live fee exceeds its immutable `maximumCoreFee`.
The adapter cannot pay a relay reward or acknowledgment bounty; the direct
`IOutbox.publishMessage` path charges only the core fee. A relayer or proof submitter must therefore
be arranged separately under the official USC process. Unused ATTEST sent to the adapter is not
withdrawable by this version.

`isAcknowledged` only proxies the bound Outbox's stored acknowledgment state. It does not prove that
the destination target produced a legally valid cure, that a relayer is available, or that an
acknowledgment incentive was funded.

## Activation boundary

Deploying these contracts does not create or activate a facility, policy, registry claim, receiver
authorization, target allowance, remedy asset transfer, operator signer, relayer, or production
approval. Those actions require separate exact configuration, funding, review, and human
authorization. Keep the executable operator read-only until that evidence is complete.
