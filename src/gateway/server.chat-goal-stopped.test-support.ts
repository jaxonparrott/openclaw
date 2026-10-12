import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi, type Mock, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

type StoppedGoalFixture = {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  sessionId: string;
  runEmbeddedAgent: MockInstance<typeof runEmbeddedAgent>;
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  userMessages: () => unknown[];
  goalStart: (
    message: string,
    idempotencyKey: string,
  ) => {
    sessionKey: string;
    sessionId: string;
    message: string;
    idempotencyKey: string;
    intent: { kind: string; version: number; issuedAtMs: number };
  };
  rpc: (
    method: "chat.send" | "chat.abort" | "sessions.goal.update",
    params: Record<string, unknown>,
  ) => Promise<Mock<RespondFn>>;
  waitForModelRun: (count?: number) => Promise<void>;
  waitForDispatchEnd: () => Promise<void>;
  withHeldModel: (run: () => Promise<void>) => Promise<void>;
  holdModelUntil: (release: Promise<void>) => void;
  resetModelStarted: () => void;
  expectNoDispatch: () => void;
};

export function registerStoppedGoalTests(getFixture: () => StoppedGoalFixture) {
  it("resumes a paused Goal after Stop settles without replaying the cancelled turn", async () => {
    const {
      context,
      sessionKey,
      sessionId,
      runEmbeddedAgent,
      scope,
      userMessages,
      goalStart,
      rpc,
      waitForModelRun,
      waitForDispatchEnd,
      withHeldModel,
      holdModelUntil,
      resetModelStarted,
    } = getFixture();
    const start = goalStart("Finish the stopped checklist", "goal-stopped-start");
    const release = createDeferred();
    holdModelUntil(release.promise);
    let goalId: string | undefined;
    try {
      expect((await rpc("chat.send", start)).mock.calls[0]?.[0]).toBe(true);
      await waitForModelRun();
      goalId = loadSessionEntry(scope())?.goal?.id;
      const update = { sessionKey, sessionId, goalId, issuedAtMs: Date.now() };
      expect(
        (
          await rpc("sessions.goal.update", {
            ...update,
            action: "pause",
            operationId: "goal-stopped-pause",
          })
        ).mock.calls[0]?.[0],
      ).toBe(true);
      const busy = await rpc("sessions.goal.update", {
        ...update,
        action: "resume",
        operationId: "goal-still-running-resume",
      });
      expect(busy.mock.calls[0]?.[0]).toBe(false);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const active = expectDefined(
        context.chatAbortControllers.get(start.idempotencyKey),
        "Expected the active Goal run before Stop",
      );
      active.controller.signal.addEventListener("abort", () => release.resolve(), { once: true });
      const stopped = await rpc("chat.abort", { sessionKey, runId: start.idempotencyKey });
      expect(stopped.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    } finally {
      release.resolve();
      await waitForDispatchEnd();
    }
    expect(loadSessionEntry(scope())).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      goal: { id: goalId, status: "paused" },
    });
    const resume = {
      sessionKey,
      sessionId,
      goalId,
      action: "resume",
      operationId: "goal-stopped-resume",
      issuedAtMs: Date.now(),
    };
    context.chatQueuedTurns.set("pending-goal-reply", {
      controller: new AbortController(),
      sessionKey,
      sessionId,
    });
    try {
      const queued = await rpc("sessions.goal.update", {
        ...resume,
        operationId: "goal-queued-resume",
      });
      expect(queued.mock.calls[0]?.[0]).toBe(false);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(userMessages()).toHaveLength(1);
    } finally {
      context.chatQueuedTurns.delete("pending-goal-reply");
    }
    for (const recovery of [
      { restartRecoveryDeliveryRunId: "pending-goal-recovery" },
      { mainRestartRecovery: { cycleId: "pending-goal-cycle", revision: 1, chargedAttempts: 0 } },
    ]) {
      await patchSessionEntryCore(scope(), () => recovery);
      try {
        const recovering = await rpc("sessions.goal.update", {
          ...resume,
          operationId: randomUUID(),
        });
        expect(recovering.mock.calls[0]?.[0]).toBe(false);
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(userMessages()).toHaveLength(1);
      } finally {
        await patchSessionEntryCore(scope(), () => ({
          mainRestartRecovery: undefined,
          restartRecoveryDeliveryRunId: undefined,
        }));
      }
    }
    // Terminal fences have no recovery owner and must not permanently block new input.
    await patchSessionEntryCore(scope(), () => ({
      restartRecoveryRuns: [{ runId: start.idempotencyKey, lifecycleGeneration: "prior-gateway" }],
    }));
    resetModelStarted();
    await withHeldModel(async () => {
      const resumed = await rpc("sessions.goal.update", resume);
      expect(resumed.mock.calls[0]?.[0], JSON.stringify(resumed.mock.calls)).toBe(true);
      expect(resumed.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      await waitForModelRun(2).catch((error: unknown) => {
        throw new Error(
          `${String(error)} ${JSON.stringify({
            response: resumed.mock.calls,
            entry: loadSessionEntry(scope()),
            warnings: vi.mocked(context.logGateway.warn).mock.calls,
            errors: vi.mocked(context.logGateway.error).mock.calls,
          })}`,
        );
      });
      expect(loadSessionEntry(scope())).toMatchObject({
        status: "running",
        abortedLastRun: false,
        goal: { id: goalId, status: "active" },
      });
      expect(loadSessionEntry(scope())?.restartRecoveryRuns).toBeUndefined();
      expect((await rpc("sessions.goal.update", resume)).mock.calls[0]?.[1]).toMatchObject({
        replayed: true,
      });
      await rpc("chat.send", start);
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      expect(userMessages()).toHaveLength(2);
    });
  });

  it("rejects new Goal input if recovery takes custody after stopped-session admission", async () => {
    const { client, context, scope, goalStart, expectNoDispatch } = getFixture();
    await patchSessionEntryCore(scope(), () => ({ status: "killed", abortedLastRun: true }));
    const params = goalStart("Keep recovery ownership intact", "goal-stopped-custody-race");
    const respond = vi.fn<RespondFn>();
    let admitted = false;
    await handleChatSend(
      {
        req: { type: "req", id: "goal-stopped-custody-race", method: "chat.send", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => true,
      },
      async () => {
        admitted = true;
        await patchSessionEntryCore(scope(), () => ({
          restartRecoveryDeliveryRunId: "new-recovery-owner",
        }));
        return true;
      },
    );
    expect(admitted).toBe(true);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(loadSessionEntry(scope())).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "new-recovery-owner",
    });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expectNoDispatch();
  });
}
