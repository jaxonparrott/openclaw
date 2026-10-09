import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";

const { execute, resolveTools } = vi.hoisted(() => ({ execute: vi.fn(), resolveTools: vi.fn() }));
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const completed = { content: [{ type: "text", text: "tracked tool completed" }] };
const executionScopes: Array<AbortSignal | undefined> = [];
const constructionScopes: Array<AbortSignal | undefined> = [];

beforeEach(() => {
  executionScopes.length = 0;
  constructionScopes.length = 0;
  execute.mockReset().mockImplementation(() => {
    executionScopes.push(getAsyncWorkSignal());
    return trackAsyncWork(() => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      return completed;
    });
  });
  resolveTools.mockReset().mockImplementation(() => {
    constructionScopes.push(getAsyncWorkSignal());
    return {
      agentId: "main",
      tools: [
        {
          name: "scope_probe",
          label: "Scope probe",
          description: "Synthetic tracked tool for lifecycle proof",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
    };
  });
});

afterEach(closeMcpLoopbackServer);

async function callTool() {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("MCP runtime missing");
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.ownerToken}`,
      "content-type": "application/json",
      "x-session-key": "agent:main:scope-proof",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scope_probe", arguments: {} },
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function startFromCaller() {
  const scope = new AsyncWorkScope();
  const admission = tryBeginGatewayRootWorkAdmission("mcp-scope-test");
  if (!admission) {
    throw new Error("Caller admission unavailable");
  }
  try {
    await admission.run(() => scope.track(() => ensureMcpLoopbackServer()));
    return scope;
  } finally {
    admission.release();
  }
}

describe("MCP HTTP work ownership", () => {
  it("does not inherit an expired operator-tool invocation from its listener creator", async () => {
    const lifetime = new AbortController();
    execute.mockImplementation(() => {
      const inherited = readOperatorToolGatewayAuthority();
      inherited?.signal.throwIfAborted();
      expect(inherited).toBeUndefined();
      return completed;
    });
    await runWithOperatorToolGatewayAuthority(
      { scopes: ["operator.write"], signal: lifetime.signal },
      () => ensureMcpLoopbackServer(),
    );
    lifetime.abort(new Error("operator tool invocation authority expired"));
    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
  });

  it("drops the listener creator request while retaining fresh admitted tool authority without operator authority", async () => {
    const context = createContext();
    context.resolveGatewayContext = () => context;
    const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
      respond(true, { jobs: [] }),
    );
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "cron.list",
          scope: "operator.read",
          owner: { kind: "core", area: "cron" },
          handler,
        },
      ]);
    let creatorCurrent = true;
    await withPluginRuntimeGatewayRequestScope(
      {
        context,
        resolveGatewayContext: context.resolveGatewayContext,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => creatorCurrent,
      },
      () => ensureMcpLoopbackServer(),
    );
    creatorCurrent = false;
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("fresh-cli-scope"),
      facts: {
        runId: "fresh-cli-scope",
        agentId: "main",
        ingress: { kind: "system", boundary: "scope-test", state: "present" },
      },
    });
    let token: string | undefined;
    try {
      const admittedRunContext = await admission.admit("gateway");
      const runtime = getActiveMcpLoopbackRuntime()!;
      token = mintMcpLoopbackClientGrant({
        runtimeOwnerToken: runtime.ownerToken,
        context: {
          sessionKey: "agent:main:fresh-cli-scope",
          agentId: "main",
          runId: "fresh-cli-scope",
          senderIsOwner: false,
        },
        admittedRunContext,
      }).token;
      const captureKey = "fresh-cli-capture";
      expect(
        activateMcpLoopbackClientGrantCapture({
          token,
          runtimeOwnerToken: "wrong-runtime-owner",
          captureKey,
        }),
      ).toBe(false);
      expect(
        activateMcpLoopbackClientGrantCapture({
          token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        }),
      ).not.toBe(false);
      execute.mockImplementation(async () => {
        expect(getGatewayToolCallerIdentity()?.operatorAuthority).toBeUndefined();
        expect(await callInProcessGatewayTool("cron.list", {})).toEqual({ jobs: [] });
        expect(getPluginRuntimeGatewayRequestScope()?.hasCurrentClientAuthority).toBeUndefined();
        return completed;
      });
      const request = (capture = captureKey) =>
        fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-openclaw-cli-capture-key": capture,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "scope_probe", arguments: {} },
          }),
        });
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { ...completed, isError: false } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect((await request("wrong-capture")).status).toBe(401);
      deactivateMcpLoopbackClientGrantCapture({
        token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      });
      expect((await request()).status).toBe(401);
      expect(
        activateMcpLoopbackClientGrantCapture({
          token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        }),
      ).not.toBe(false);
      revokeMcpLoopbackClientGrant(token);
      expect((await request()).status).toBe(401);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      if (token) {
        revokeMcpLoopbackClientGrant(token);
      }
      admission.close();
    }
  });

  it("serves fresh request scopes after its replacement creator closes", async () => {
    const predecessor = await startFromCaller();
    await Promise.all([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
    await predecessor.drain();
    const creator = await startFromCaller();
    await creator.drain();
    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
    expect(resolveTools).toHaveBeenCalledTimes(1);
    expect(constructionScopes[0]).toBeDefined();
    expect(constructionScopes[0]?.aborted).toBe(false);
    expect(constructionScopes[0]).not.toBe(creator.signal);
    expect(executionScopes[0]).toBeDefined();
    expect(executionScopes[1]).toBeDefined();
    expect(executionScopes[0]).not.toBe(executionScopes[1]);
    for (const signal of executionScopes) {
      expect(signal).not.toBe(constructionScopes[0]);
      expect(signal?.aborted).toBe(true);
    }
    await closeMcpLoopbackServer();
    expect(constructionScopes[0]?.aborted).toBe(true);
  });

  it("joins accepted tool cleanup without closing a replacement listener", async () => {
    const releaseCleanup = createDeferred();
    const cleanupStarted = createDeferred();
    let cleanup: Promise<unknown> | undefined;
    execute.mockImplementationOnce(() => {
      cleanup = trackAsyncWork(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        return trackAsyncWork(() => completed);
      });
      return completed;
    });
    await ensureMcpLoopbackServer();
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      await cleanupStarted.promise;
      closing = closeMcpLoopbackServer().then(() => {
        closed = true;
      });
      await ensureMcpLoopbackServer();
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      expect(closed).toBe(false);
      releaseCleanup.resolve();
      await closing;
      await expect(cleanup).resolves.toEqual(completed);
      expect(await callTool()).toMatchObject({ result: { isError: false } });
    } finally {
      releaseCleanup.resolve();
      await cleanup;
      await closing;
    }
  });
});
