import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../src/main/jsonl-decoder";
import type { RpcRecord } from "../src/shared/contracts";

const piPath = process.env.PI_DESKTOP_PI_PATH ?? "/opt/homebrew/bin/pi";
const runRpcIntegration = process.env.RUN_PI_INTEGRATION === "1" && existsSync(piPath);
const runPromptIntegration = process.env.RUN_PI_PROMPT_INTEGRATION === "1" && existsSync(piPath);

function rpcProcess(extraArguments: string[] = []) {
  return spawn(piPath, ["--mode", "rpc", "--no-session", "--no-approve", "--no-extensions", ...extraArguments], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe.skipIf(!runRpcIntegration)("Pi RPC integration", () => {
  it("reads state, thinking levels, models, and shell output", async () => {
    const child = rpcProcess();
    const decoder = new JsonlDecoder<RpcRecord>();
    const responses = new Map<string, RpcRecord>();
    const complete = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Pi RPC integration timed out")), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        for (const record of decoder.push(chunk)) {
          if (record.type === "response" && typeof record.id === "string") responses.set(record.id, record);
          if (responses.size === 4) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.once("error", reject);
    });

    for (const command of [
      { id: "state", type: "get_state" },
      { id: "thinking", type: "get_available_thinking_levels" },
      { id: "models", type: "get_available_models" },
      { id: "shell", type: "bash", command: "printf integration-ok" },
    ]) child.stdin.write(`${JSON.stringify(command)}\n`);

    try {
      await complete;
      expect(responses.get("state")?.success).toBe(true);
      expect(((responses.get("thinking")?.data as Record<string, unknown>).levels as unknown[]).length).toBeGreaterThan(0);
      expect(((responses.get("models")?.data as Record<string, unknown>).models as unknown[]).length).toBeGreaterThan(0);
      expect((responses.get("shell")?.data as Record<string, unknown>).output).toBe("integration-ok");
    } finally {
      child.kill();
    }
  }, 35_000);

  it("round-trips an extension UI request and response", async () => {
    const child = rpcProcess([
      "--no-extensions",
      "--extension",
      resolve("tests/fixtures/rpc-ui-extension.ts"),
    ]);
    const decoder = new JsonlDecoder<RpcRecord>();
    let requestId = "";
    let notification = "";
    const complete = new Promise<void>((resolveComplete, reject) => {
      const timer = setTimeout(() => reject(new Error("Extension UI integration timed out")), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        for (const record of decoder.push(chunk)) {
          if (record.type === "extension_ui_request" && record.method === "input") {
            requestId = String(record.id);
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, value: "desktop-ok" })}\n`);
          }
          if (record.type === "extension_ui_request" && record.method === "notify") {
            notification = String(record.message);
            clearTimeout(timer);
            resolveComplete();
          }
        }
      });
      child.once("error", reject);
    });
    child.stdin.write(`${JSON.stringify({ id: "ui", type: "prompt", message: "/desktop-ui-test" })}\n`);

    try {
      await complete;
      expect(requestId).not.toBe("");
      expect(notification).toBe("Received: desktop-ok");
    } finally {
      child.kill();
    }
  }, 35_000);
});

describe.skipIf(!runPromptIntegration)("Pi prompt streaming integration", () => {
  it("receives streamed text and settles", async () => {
    const child = rpcProcess();
    const decoder = new JsonlDecoder<RpcRecord>();
    let streamedText = "";
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Pi prompt integration timed out")), 90_000);
      child.stdout.on("data", (chunk: Buffer) => {
        for (const record of decoder.push(chunk)) {
          const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
          if (record.type === "message_update" && update?.type === "text_delta") streamedText += String(update.delta ?? "");
          if (record.type === "agent_settled") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.once("error", reject);
    });
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Reply with exactly: stream-ok" })}\n`);

    try {
      await settled;
      expect(streamedText.toLowerCase()).toContain("stream-ok");
    } finally {
      child.kill();
    }
  }, 95_000);
});
