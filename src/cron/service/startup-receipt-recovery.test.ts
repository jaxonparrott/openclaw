import { describe, expect, it, vi } from "vitest";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  finishCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  makeCronRecoveryJob as makeJob,
} from "../store/run-receipt-store.test-support.js";
import { prepareCronRunReceiptWriteSchema } from "../store/run-receipt-write-admission.js";
import { listForeignReceipts } from "./foreign-receipt-monitor.js";
import { start, stop } from "./ops-lifecycle.js";
import { createCronRunHandle, finishCronRun } from "./run-history.js";
import {
  claimCronRecoveryReceipt as claimReceipt,
  makeCronRecoveryState as makeState,
} from "./run-recovery.test-support.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-startup-receipts-" });

function receiptStatus(receiptId: string) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare("SELECT status, error_text FROM cron_run_receipts WHERE receipt_id = ?")
      .get(receiptId),
  );
}

describe("startup receipt discovery", () => {
  it.each(["enabled", "disabled", "removed"] as const)(
    "interrupts a dead owner whose %s job has no run marker",
    async (definition) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob(`markerless-${definition}`, startedAtMs);
      delete job.state.runningAtMs;
      job.state.nextRunAtMs = startedAtMs + 60_000;
      job.state.lastRunStatus = "error";
      job.state.lastError = "retained historical failure";
      job.enabled = definition === "enabled";
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAtMs);
      releaseLocalCronRunReceiptOwnership(receipt);
      if (definition === "removed") {
        await writeCronStoreSnapshot({ storePath, jobs: [] });
      }
      const state = makeState(logger, storePath, startedAtMs + 1);
      state.deps.runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
      try {
        await start(state);
        expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "interrupted" });
        expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(state.deps.runCommandJob).not.toHaveBeenCalled();
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        if (definition === "removed") {
          expect(persisted).toBeUndefined();
        } else {
          expect(persisted).toMatchObject({
            enabled: job.enabled,
            schedule: job.schedule,
            state: { lastRunStatus: "error", lastError: "retained historical failure" },
          });
        }
      } finally {
        stop(state);
      }
    },
  );

  it.each([false, true])(
    "monitors a live markerless owner (removed=%s) until it dies",
    async (removed) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob("live-markerless", startedAtMs);
      job.enabled = false;
      delete job.state.runningAtMs;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAtMs);
      expect(receipt.ownerPid).toBe(process.pid);
      expect(receipt.ownerStartTime).toBe(getFileLockProcessStartTime(process.pid));
      if (removed) {
        await writeCronStoreSnapshot({ storePath, jobs: [] });
      }
      const clock = createGatewaySchedulerClock(startedAtMs + 1);
      const state = createCronServiceState({
        ...makeState(logger, storePath, startedAtMs + 1).deps,
        scheduler: createTestGatewayScheduler(clock.clock),
        nowMs: clock.clock.now,
      });
      try {
        await start(state);
        expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "running" });
        expect(listForeignReceipts(state)).toEqual([receipt]);
        releaseLocalCronRunReceiptOwnership(receipt);
        await clock.advanceBy(2_000);
        expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "interrupted" });
        expect(listForeignReceipts(state)).toEqual([]);
      } finally {
        releaseLocalCronRunReceiptOwnership(receipt);
        stop(state);
      }
    },
  );

  it("leaves another store partition's receipt untouched", async () => {
    const { storePath } = await makeStorePath();
    const { storePath: otherStorePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("shared-job-id", startedAtMs);
    job.enabled = false;
    delete job.state.runningAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    await writeCronStoreSnapshot({ storePath: otherStorePath, jobs: [job] });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const unrelated = claimReceipt(otherStorePath, job, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);
    releaseLocalCronRunReceiptOwnership(unrelated);
    const state = makeState(logger, storePath, startedAtMs + 1);
    try {
      await start(state);
      expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "interrupted" });
      expect(receiptStatus(unrelated.receiptId)).toMatchObject({ status: "running" });
    } finally {
      stop(state);
    }
  });

  it.each([false, true])(
    "does not retire replacement custody after discovery (new marker=%s)",
    async (running) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob("replaced-markerless", startedAtMs);
      job.enabled = false;
      delete job.state.runningAtMs;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const oldReceipt = claimReceipt(storePath, job, startedAtMs);
      releaseLocalCronRunReceiptOwnership(oldReceipt);
      const read = stateRead.executeExistingOpenClawStateRead;
      let replacement: ReturnType<typeof claimReceipt> | undefined;
      const race = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const observed = await read(...args);
          if (
            args[1].type === "cron.observeRunRecovery" &&
            args[1].includeActiveReceipts &&
            !replacement
          ) {
            runOpenClawStateWriteTransaction(({ db }) =>
              finishCronRunReceiptInDatabase({
                database: db,
                receiptSchema: prepareCronRunReceiptWriteSchema(db),
                handle: oldReceipt,
                status: "error",
                finishedAtMs: startedAtMs + 1,
              }),
            );
            const revised = structuredClone(job);
            revised.name = "replacement revision";
            revised.payload = { kind: "command", argv: ["printf", "replacement"] };
            await writeCronStoreSnapshot({ storePath, jobs: [revised] });
            replacement = claimReceipt(storePath, revised, startedAtMs + 1);
            if (running) {
              revised.state.runningAtMs = startedAtMs + 1;
              revised.state.runningReceiptId = replacement.receiptId;
              await writeCronStoreSnapshot({ storePath, jobs: [revised] });
            }
          }
          return observed;
        });
      const state = makeState(logger, storePath, startedAtMs + 2);
      try {
        await start(state);
        expect(replacement).toBeDefined();
        expect(replacement?.configRevision).not.toBe(oldReceipt.configRevision);
        expect(receiptStatus(oldReceipt.receiptId)).toMatchObject({ status: "error" });
        expect(receiptStatus(replacement!.receiptId)).toMatchObject({ status: "running" });
        expect(listForeignReceipts(state)).toEqual([replacement]);
        if (running) {
          expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
            runningAtMs: startedAtMs + 1,
            runningReceiptId: replacement!.receiptId,
          });
        }
      } finally {
        race.mockRestore();
        if (replacement) {
          releaseLocalCronRunReceiptOwnership(replacement);
        }
        stop(state);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "interrupts a fresh definitely dead foreign PID without using age",
    async () => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob("definitely-dead-foreign-owner", startedAtMs);
      job.enabled = false;
      delete job.state.runningAtMs;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const prepared = prepareCronRunReceiptClaim({
        storePath,
        job,
        agentId: "alpha",
        startedAtMs,
        observed: undefined,
      });
      // Synthetic receipt, actual Linux liveness probes: ESRCH cannot be an age-based guess.
      prepared.handle.ownerPid = 2_147_483_646;
      expect(isPidDefinitelyDead(prepared.handle.ownerPid)).toBe(true);
      expect(getFileLockProcessStartTime(prepared.handle.ownerPid)).toBeNull();
      const receipt = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabaseForTest({
          database: db,
          prepared,
          resolveAgentId: (current) => current.agentId!,
        }),
      );
      releaseLocalCronRunReceiptOwnership(receipt);
      const state = makeState(logger, storePath, startedAtMs + 1);
      try {
        await start(state);
        expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "interrupted" });
      } finally {
        stop(state);
      }
    },
  );

  it("preserves retained finalized history when its markerless receipt loses its owner", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("retained-history-markerless", startedAtMs);
    job.enabled = false;
    delete job.state.runningAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const state = makeState(logger, storePath, startedAtMs + 1);
    const task = createCronRunHandle({ state, job, startedAt: startedAtMs, runReceipt: receipt });
    await finishCronRun(state, {
      taskRunId: task.runId,
      job,
      event: {
        action: "finished",
        jobId: job.id,
        job,
        status: "error",
        completionStatus: "failed",
        error: "retained native failure",
        deliveryStatus: "not-requested",
        runAtMs: startedAtMs,
        durationMs: 1,
      },
    });
    const before = readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(storePath),
      jobId: job.id,
    });
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({ status: "error", error: "retained native failure" });
    releaseLocalCronRunReceiptOwnership(receipt);
    try {
      await start(state);
      expect(receiptStatus(receipt.receiptId)).toMatchObject({ status: "interrupted" });
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id }),
      ).toEqual(before);
    } finally {
      stop(state);
    }
  });
});
