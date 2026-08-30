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

function incident(statePath, state, reason, writeState) {
  const incidentState = {
    ...state,
    phase: "incident",
    pending: null,
    incident: {
      reason,
      recordedAt: new Date().toISOString(),
      transaction: state.pending ?? null,
    },
  };
  writeState(statePath, incidentState);
  throw new OperatorIncidentError(reason);
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
  if (state.pending) {
    const kind = state.pending.kind;
    const successPhase = {
      approval: "approved",
      commit: "committed",
      reveal: "revealed",
      release: "released",
    }[kind];
    try {
      const reconciled = await reconcileTransaction({
        provider,
        state,
        statePath,
        kind,
        successPhase,
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind(kind, state)
          : undefined,
        ...confirmationPolicy,
      });
      state = validateResumeState(reconciled.state, expectedState);
    } catch (error) {
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
        incident(statePath, state, error.message, writeState);
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
      return { state, status: "released" };
    }
    assertCanStartTransaction();
    const request = await jobs.releaseCommit.populateTransaction(jobId);
    state = await prepareTransaction({
      kind: "release",
      signer: hunter,
      request,
      state,
      statePath,
    });
    state = (
      await reconcileTransaction({
        provider,
        state,
        statePath,
        kind: "release",
        successPhase: "released",
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind("release", state)
          : undefined,
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
    return { state, status: "released" };
  }
  if (liveJob.state === EXPIRED_JOB_STATE) {
    incident(
      statePath,
      state,
      `Proof job ${jobId} expired with a live commitment`,
      writeState,
    );
  }
  if (liveJob.state !== OPEN_JOB_STATE) {
    incident(
      statePath,
      state,
      `Proof job ${jobId} finalized in an unsupported state with a live commitment`,
      writeState,
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
    );
  }
  const blockNumber = await provider.getBlockNumber();
  if (BigInt(blockNumber) > commitment.revealDeadlineBlock) {
    incident(
      statePath,
      state,
      "Commitment reveal window elapsed; bond requires incident handling",
      writeState,
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
    request,
    state,
    statePath,
  });
  try {
    state = (
      await reconcileTransaction({
        provider,
        state,
        statePath,
        kind: "reveal",
        successPhase: "revealed",
        expectedIntent: expectedIntentForKind
          ? await expectedIntentForKind("reveal", state)
          : undefined,
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
    return { state, status: "revealed" };
  } catch (error) {
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
      incident(statePath, state, error.message, writeState);
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
