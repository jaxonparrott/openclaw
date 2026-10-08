import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { isCodeModeControlTool, markCodeModeControlTool } from "../../code-mode-control-tools.js";
import type { AgentTool } from "../../runtime/index.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import {
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "./tool-definition-wrapper.js";

describe("tool definition result content source", () => {
  it("keeps the real wait tool synchronous through both adapter directions", () => {
    const tool = createSessionsYieldTool({ sessionId: "session" });
    const definition = createToolDefinitionFromAgentTool(tool);
    expect(definition.async).toBe(false);
    expect(wrapToolDefinition(definition).async).toBe(false);
  });

  it("survives both AgentTool adapter directions", () => {
    const tool: AgentTool = {
      name: "network_reader",
      label: "Network reader",
      description: "Reads external content",
      parameters: Type.Object({}),
      resultContentSource: "network",
      execute: async () => ({ content: [], details: {} }),
    };

    const definition = createToolDefinitionFromAgentTool(tool);
    expect(definition.resultContentSource).toBe("network");
    expect(wrapToolDefinition(definition).resultContentSource).toBe("network");
  });

  it("preserves Code Mode control identity in both adapter directions", () => {
    const tool = markCodeModeControlTool({
      name: "exec",
      label: "exec",
      description: "Code Mode exec",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    } satisfies AgentTool);

    const definition = createToolDefinitionFromAgentTool(tool);
    expect(isCodeModeControlTool(definition)).toBe(true);
    expect(isCodeModeControlTool(wrapToolDefinition(definition))).toBe(true);
  });
});
