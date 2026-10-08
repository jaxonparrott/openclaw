import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliOutput } from "./cli-output-contracts.js";

type TextSpan = { start: number; end: number; messageId: string; text: string; sessionId?: string };

/** Provider identities are admitted only after the parser selects their complete text. */
export class CliAssistantTextReceipt {
  private readonly spans: TextSpan[] = [];
  private readonly messages = new Map<
    string,
    { messageId: string; text: string; sessionId?: string }
  >();
  private lastExternalId: string | undefined;

  append(span: TextSpan): void {
    const last = this.spans.at(-1);
    if (
      last?.messageId === span.messageId &&
      last.sessionId === span.sessionId &&
      last.end === span.start
    ) {
      last.end = span.end;
      last.text += span.text;
    } else {
      this.spans.push(span);
    }
  }

  observe(
    externalId: unknown,
    messageId: string,
    message: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const id = typeof externalId === "string" ? externalId.trim() : "";
    const text = Array.isArray(message.content)
      ? message.content
          .map((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("")
      : typeof message.content === "string"
        ? message.content
        : "";
    if (id && text) {
      this.messages.set(id, { messageId, text, sessionId });
      this.lastExternalId = id;
    }
  }

  read(params: {
    start: number;
    sessionId?: string;
    resultText?: string;
    previous?: CliOutput["transcriptTextReceipt"];
  }): CliOutput["transcriptTextReceipt"] {
    const { start, sessionId, resultText, previous } = params;
    if (!sessionId) {
      return undefined;
    }
    const messages = new Map(
      previous?.cliSessionId === sessionId
        ? previous.messages.map((message) => [message.externalId, message])
        : [],
    );
    for (const [externalId, native] of this.messages) {
      if (native.sessionId !== sessionId) {
        continue;
      }
      const selected =
        resultText === undefined
          ? this.spans
              .filter(
                (span) =>
                  span.messageId === native.messageId &&
                  span.sessionId === sessionId &&
                  span.start >= start,
              )
              .map((span) => span.text)
              .join("")
          : externalId === this.lastExternalId
            ? resultText
            : "";
      // Identity proves the source; exact producer coverage proves that its
      // whole visible body belongs to this accepted aggregate.
      if (native.text.trim() && selected.trim() === native.text.trim()) {
        messages.set(externalId, { externalId, textSha256: sha256Hex(native.text) });
      }
    }
    return messages.size
      ? { provider: "claude-cli", cliSessionId: sessionId, messages: [...messages.values()] }
      : undefined;
  }
}
