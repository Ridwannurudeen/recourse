import {
  OperatorIncidentError,
  atomicWriteJson,
  prepareJournaledTransaction,
  reconcileJournaledTransaction,
} from "./operator-core.mjs";
import { validateResumeState } from "./horizon1-core.mjs";

const OPEN_JOB_STATE = 0n;
const OUTCOME_REACHED_JOB_STATE = 1n;
const ATTEMPTS_EXHAUSTED_JOB_STATE = 2n;
const EXPIRED_JOB_STATE = 3n;
const REVEAL_GAS_LIMIT = 1_500_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function assertHorizon1BroadcastStillValid({
  kind,
  provider,
  jobsRead,
  hunter,
  jobId,
  state,
}) {
  const liveJob = await jobsRead.getJob(jobId);
  if (kind === "approval" || kind === "commit") {
    const latestBlock = await provider.getBlock("latest");
    if (
      !latestBlock ||
      liveJob.state !== OPEN_JOB_STATE ||
      BigInt(latestBlock.timestamp) >= BigInt(liveJob.expiry)
    ) {
      throw new OperatorIncidentError(
        `${kind} transaction is no longer valid for the live proof job`,
      );
    }
    if (kind === "commit") {
      const [commitment, reservedBy] = await Promise.all([
        jobsRead.getCommitment(jobId, hunter.address),
        jobsRead.evidenceReservedBy(jobId, state.evidenceDigest),
      ]);
      if (reservedBy.toLowerCase() !== ZERO_ADDRESS) {
        throw new OperatorIncidentError(
          reservedBy.toLowerCase() === hunter.address.toLowerCase()
            ? "Commit evidence digest is already reserved"
            : "Commit evidence digest is reserved by another hunter",
        );
      }
      if (
        commitment.bond !== 0n &&
        (commitment.digest !== state.commitment ||
          commitment.evidenceDigest !== state.evidenceDigest)
      ) {
        throw new OperatorIncidentError(
          "Commit transaction no longer matches the live commitment",
        );
      }
    }
    return true;
  }
  const commitment = await jobsRead.getCommitment(jobId, hunter.address);
  if (kind === "reveal") {
    const latestBlock = await provider.getBlock("latest");
    if (
      !latestBlock ||
      liveJob.state !== OPEN_JOB_STATE ||
      BigInt(latestBlock.timestamp) >= BigInt(liveJob.expiry) ||
      BigInt(latestBlock.number) <= commitment.committedBlock ||
      BigInt(latestBlock.number) > commitment.revealDeadlineBlock ||
      commitment.digest !== state.commitment ||
      commitment.evidenceDigest !== state.evidenceDigest ||
      commitment.bond === 0n
    ) {
      throw new OperatorIncidentError(
        "Reveal transaction is no longer valid for the live commitment",
      );
    }
    return true;
  }
  if (kind === "release") {
    if (
      (liveJob.state !== OUTCOME_REACHED_JOB_STATE &&
        liveJob.state !== ATTEMPTS_EXHAUSTED_JOB_STATE) ||
      commitment.bond === 0n
    ) {
      throw new OperatorIncidentError(
        "Release transaction is no longer valid for the live commitment",
      );
    }
    return true;
  }
  if (kind === "claim") {
    const amount = await jobsRead.claimable(liveJob.token, hunter.address);
    if (amount === 0n) {
      throw new OperatorIncidentError("Claim transaction has no live proceeds");
    }
    return true;
  }
  throw new Error(`Unknown proof-job transaction kind: ${kind}`);
}

function lifecycleRevert(error, jobs) {
  const revert = error?.revert;
  if (!revert?.data || typeof jobs?.interface?.parseError !== "function") {
    return revert;
  }
  try {
    const parsed = jobs.interface.parseError(revert.data);
    if (!parsed) return revert;
    const args = [...parsed.args].map((value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    return {
      ...revert,
      name: parsed.name,
      args,
      reason: `${parsed.name}(${args.join(", ")})`,
    };
  } catch {
    return revert;
  }
}

function incident(statePath, state, error, writeState, jobs) {
  const reason = error instanceof Error ? error.message : error;
  const revert = lifecycleRevert(error, jobs);
  const receipt = error?.receipt;
  const incidentState = {
    ...state,
    phase: "incident",
    pending: null,
    incident: {
      reason,
      recordedAt: new Date().toISOString(),
      transaction: state.pending ?? null,
      ...(receipt
        ? {
            receipt: {
              transactionHash: receipt.hash ?? null,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash ?? null,
              status: receipt.status,
            },
          }
        : {}),
      ...(revert ? { revert } : {}),
    },
  };
  writeState(statePath, incidentState);
  const incidentError = new OperatorIncidentError(reason);
  incidentError.terminalIncident = true;
  throw incidentError;
}

export async function recoverHorizon1TargetState({
  provider,
  jobsRead,
  jobs,
  hunter,
  jobId,
  state,
  statePath,
  expectedState,
  confirmationPolicy,
  assertCanStartTransaction,
  expectedIntentForKind,
  prepareTransaction = prepareJournaledTransaction,
  reconcileTransaction = reconcileJournaledTransaction,
  writeState = atomicWriteJson,
}) {
  const reconcileSafely = async (input) => {
    try {
      return await reconcileTransaction(input);
    } catch (error) {
      if (
        error instanceof OperatorIncidentError &&
        error.receipt &&
        error.receipt?.status !== 1
      ) {
        incident(statePath, input.state, error, writeState, jobs);
      }
      throw error;
    }
  };
  if (state.pending) {
    const kind = state.pending.kind;
    const successPhase = {
      approval: "approved",
      commit: "committed",
      reveal: "revealed",
      release: "released",
      claim: state.phase,
    }[kind];
    try {
      const reconciled = await reconcileSafely({
        provider,
        state,
        statePath,
        kind,
        successPhase,
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind(kind, state)
          : undefined,
        beforeBroadcast: () =>
          assertHorizon1BroadcastStillValid({
            kind,
            provider,
            jobsRead,
            hunter,
            jobId,
            state,
          }),
        ...confirmationPolicy,
      });
      state = validateResumeState(reconciled.state, expectedState);
    } catch (error) {
      if (error.terminalIncident === true) throw error;
      if (kind !== "reveal" || !(error instanceof OperatorIncidentError)) {
        throw error;
      }
      const [liveJob, liveCommitment] = await Promise.all([
        jobsRead.getJob(jobId),
        jobsRead.getCommitment(jobId, hunter.address),
      ]);
      if (
        (liveJob.state !== OUTCOME_REACHED_JOB_STATE &&
          liveJob.state !== ATTEMPTS_EXHAUSTED_JOB_STATE) ||
        liveCommitment.bond === 0n
      ) {
        incident(statePath, state, error, writeState, jobs);
      }
      state = {
        ...state,
        phase: "committed",
        pending: null,
        failedRevealTransactionHash: state.pending.transactionHash,
      };
      writeState(statePath, state);
    }
  }

  if (state.phase === "revealed" || state.phase === "released") {
    if (state.claimSettlementComplete === true) {
      return { state, status: state.phase };
    }
    const liveJob = await jobsRead.getJob(jobId);
    const claimable = await jobsRead.claimable(liveJob.token, hunter.address);
    if (claimable === 0n) {
      state = {
        ...state,
        claimSettlementComplete: true,
        updatedAt: new Date().toISOString(),
      };
      writeState(statePath, state);
      state = validateResumeState(state, expectedState);
      return { state, status: state.phase };
    }
    assertCanStartTransaction();
    state = await prepareTransaction({
      kind: "claim",
      signer: hunter,
      feePolicy: confirmationPolicy.feePolicy,
      request: await jobs.claim.populateTransaction(liveJob.token),
      state,
      statePath,
    });
    state = (
      await reconcileSafely({
        provider,
        state,
        statePath,
        kind: "claim",
        successPhase: state.phase,
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind("claim", state)
          : undefined,
        beforeBroadcast: () =>
          assertHorizon1BroadcastStillValid({
            kind: "claim",
            provider,
            jobsRead,
            hunter,
            jobId,
            state,
          }),
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
    state = {
      ...state,
      claimSettlementComplete: true,
      updatedAt: new Date().toISOString(),
    };
    writeState(statePath, state);
    state = validateResumeState(state, expectedState);
    return { state, status: state.phase };
  }
  if (state.phase === "incident") {
    throw new OperatorIncidentError(state.incident.reason);
  }
  if (state.phase === "prepared" || state.phase === "approved") {
    return { state, status: "needs-source" };
  }

  const liveJob = await jobsRead.getJob(jobId);
  const commitment = await jobsRead.getCommitment(jobId, hunter.address);
  if (
    liveJob.state === OUTCOME_REACHED_JOB_STATE ||
    liveJob.state === ATTEMPTS_EXHAUSTED_JOB_STATE
  ) {
    if (commitment.bond === 0n) {
      state = { ...state, phase: "released", pending: null };
      writeState(statePath, state);
      return recoverHorizon1TargetState({
        provider,
        jobsRead,
        jobs,
        hunter,
        jobId,
        state,
        statePath,
        expectedState,
        confirmationPolicy,
        assertCanStartTransaction,
        expectedIntentForKind,
        prepareTransaction,
        reconcileTransaction,
        writeState,
      });
    }
    assertCanStartTransaction();
    const request = await jobs.releaseCommit.populateTransaction(jobId);
    state = await prepareTransaction({
      kind: "release",
      signer: hunter,
      feePolicy: confirmationPolicy.feePolicy,
      request,
      state,
      statePath,
    });
    state = (
      await reconcileSafely({
        provider,
        state,
        statePath,
        kind: "release",
        successPhase: "released",
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind("release", state)
          : undefined,
        beforeBroadcast: () =>
          assertHorizon1BroadcastStillValid({
            kind: "release",
            provider,
            jobsRead,
            hunter,
            jobId,
            state,
          }),
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
    return recoverHorizon1TargetState({
      provider,
      jobsRead,
      jobs,
      hunter,
      jobId,
      state,
      statePath,
      expectedState,
      confirmationPolicy,
      assertCanStartTransaction,
      expectedIntentForKind,
      prepareTransaction,
      reconcileTransaction,
      writeState,
    });
  }
  if (liveJob.state === EXPIRED_JOB_STATE) {
    incident(
      statePath,
      state,
      `Proof job ${jobId} expired with a live commitment`,
      writeState,
      jobs,
    );
  }
  if (liveJob.state !== OPEN_JOB_STATE) {
    incident(
      statePath,
      state,
      `Proof job ${jobId} finalized in an unsupported state with a live commitment`,
      writeState,
      jobs,
    );
  }
  if (
    commitment.digest !== state.commitment ||
    commitment.evidenceDigest !== state.evidenceDigest ||
    commitment.committedBlock !== BigInt(state.commitBlock) ||
    commitment.bond === 0n
  ) {
    incident(
      statePath,
      state,
      "Stored resume state does not match the live commitment",
      writeState,
      jobs,
    );
  }
  const blockNumber = await provider.getBlockNumber();
  if (BigInt(blockNumber) > commitment.revealDeadlineBlock) {
    incident(
      statePath,
      state,
      "Commitment reveal window elapsed; bond requires incident handling",
      writeState,
      jobs,
    );
  }
  if (blockNumber < state.commitBlock + 1) {
    return { state, status: "waiting-reveal-block" };
  }

  assertCanStartTransaction();
  const request = await jobs.revealEvidence.populateTransaction(
    jobId,
    state.evidenceDigest,
    state.salt,
    state.proof,
    { gasLimit: REVEAL_GAS_LIMIT },
  );
  state = await prepareTransaction({
    kind: "reveal",
    signer: hunter,
    feePolicy: confirmationPolicy.feePolicy,
    request,
    state,
    statePath,
  });
  try {
    state = (
      await reconcileSafely({
        provider,
        state,
        statePath,
        kind: "reveal",
        successPhase: "revealed",
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind("reveal", state)
          : undefined,
        beforeBroadcast: () =>
          assertHorizon1BroadcastStillValid({
            kind: "reveal",
            provider,
            jobsRead,
            hunter,
            jobId,
            state,
          }),
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
    return recoverHorizon1TargetState({
      provider,
      jobsRead,
      jobs,
      hunter,
      jobId,
      state,
      statePath,
      expectedState,
      confirmationPolicy,
      assertCanStartTransaction,
      expectedIntentForKind,
      prepareTransaction,
      reconcileTransaction,
      writeState,
    });
  } catch (error) {
    if (error.terminalIncident === true) throw error;
    if (!(error instanceof OperatorIncidentError)) throw error;
    const [finalJob, finalCommitment] = await Promise.all([
      jobsRead.getJob(jobId),
      jobsRead.getCommitment(jobId, hunter.address),
    ]);
    if (
      (finalJob.state !== OUTCOME_REACHED_JOB_STATE &&
        finalJob.state !== ATTEMPTS_EXHAUSTED_JOB_STATE) ||
      finalCommitment.bond === 0n
    ) {
      incident(statePath, state, error, writeState, jobs);
    }
    state = {
      ...state,
      phase: "committed",
      pending: null,
      failedRevealTransactionHash: state.pending.transactionHash,
    };
    writeState(statePath, state);
    return recoverHorizon1TargetState({
      provider,
      jobsRead,
      jobs,
      hunter,
      jobId,
      state,
      statePath,
      expectedState,
      confirmationPolicy,
      assertCanStartTransaction,
      expectedIntentForKind,
      prepareTransaction,
      reconcileTransaction,
      writeState,
    });
  }
}
