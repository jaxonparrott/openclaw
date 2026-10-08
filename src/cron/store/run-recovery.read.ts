import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import type {
  CronRunRecoveryObservation,
  CronRunRecoveryProposal,
  CronRunRecoveryReadCommand,
} from "./run-recovery-read.types.js";

export function observeCronRunRecoveryInDatabase(
  database: DatabaseSync,
  command: CronRunRecoveryReadCommand,
): CronRunRecoveryObservation {
  try {
    return runSqliteDeferredTransactionSync(database, () => {
      const receipts = new Map(
        readActiveCronRunReceiptsInDatabase(
          database,
          command.storeKey,
          command.includeActiveReceipts
            ? undefined
            : command.proposals.map((proposal) => proposal.jobId),
        ).map((receipt) => [receipt.jobId, receipt]),
      );
      const runningJobIds = new Set(
        command.proposals
          .filter((proposal) => proposal.runningAtMs !== undefined)
          .map((proposal) => proposal.jobId),
      );
      const proposedJobIds = new Set(command.proposals.map((proposal) => proposal.jobId));
      const discoveredJobIds = [...receipts.keys()].filter((jobId) => !proposedJobIds.has(jobId));
      for (const jobId of discoveredJobIds) {
        runningJobIds.add(jobId);
      }
      const jobs = new Map(
        loadedCronStoreFromRows(
          loadCronRows(database, command.storeKey, runningJobIds),
        ).store.jobs.map((job) => [job.id, job]),
      );
      // Retain caller proposal order; startup appends custody whose marker or job retired.
      const proposals = [
        ...command.proposals,
        ...discoveredJobIds.map((jobId) => {
          const job = jobs.get(jobId);
          return { jobId, queuedAtMs: job?.state.queuedAtMs, runningAtMs: job?.state.runningAtMs };
        }),
      ];
      return {
        kind: "observed",
        proposals: proposals.map((proposal) => {
          const job = jobs.get(proposal.jobId);
          const observed: CronRunRecoveryProposal = {
            jobId: proposal.jobId,
            receipt: receipts.get(proposal.jobId),
            runningReceiptId:
              job?.state.runningAtMs === proposal.runningAtMs
                ? job?.state.runningReceiptId
                : undefined,
          };
          if (proposal.queuedAtMs !== undefined) {
            observed.queuedAtMs = proposal.queuedAtMs;
          }
          if (proposal.runningAtMs !== undefined) {
            observed.runningAtMs = proposal.runningAtMs;
          }
          return observed;
        }),
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "no such table: cron_run_receipts") {
      return { kind: "schema-uninitialized" };
    }
    throw error;
  }
}
