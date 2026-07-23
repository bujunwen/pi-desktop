import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentRuntime, type AgentRuntimeFactory } from "../src/main/agent-manager";
import type { AgentSnapshot } from "../src/main/agent-rpc-process";
import type { AgentLaunchSpec, SettingsStore } from "../src/main/settings-store";
import type { ProjectRecord, RpcRecord } from "../src/shared/contracts";

const project: ProjectRecord = {
  id: "project-1",
  name: "Example",
  path: "/tmp/example",
  trust: "trusted",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
};

const launch: AgentLaunchSpec = {
  executable: "/tmp/pi",
  argumentPrefix: [],
  env: {},
  displayPath: "/tmp/pi",
  rpcEntry: false,
};

function snapshot(sessionFile: string): AgentSnapshot {
  return {
    project,
    state: { type: "state", sessionFile, isStreaming: false },
    messages: [],
    commands: [],
  };
}

class FakeRuntime implements AgentRuntime {
  isAlive = true;
  readonly value: AgentSnapshot;

  constructor(sessionFile: string) {
    this.value = snapshot(sessionFile);
  }

  async activate() { return this.value; }
  async snapshot() { return this.value; }
  async getModels() { return []; }
  async setModel() {}
  async getThinkingLevels() { return ["off" as const]; }
  async setThinkingLevel() {}
  async getTree() { return {}; }
  async runBash() { return {}; }
  async prompt() {}
  async abort() {}
  async runBuiltin() {}
  respondExtensionUi() {}
  dispose() { this.isAlive = false; }
}

describe("AgentManager", () => {
  it("keeps one runtime per opened session and reuses it when returning", async () => {
    const callbacks: Array<(event: RpcRecord) => void> = [];
    const runtimes: FakeRuntime[] = [];
    const factory: AgentRuntimeFactory = (_project, _launch, onEvent, sessionPath) => {
      callbacks.push(onEvent);
      const runtime = new FakeRuntime(sessionPath ?? "/tmp/latest.jsonl");
      runtimes.push(runtime);
      return runtime;
    };
    const send = vi.fn();
    let destroyed = false;
    const settings = { launchSpec: async () => launch } as unknown as SettingsStore;
    const window = {
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, send },
    } as unknown as BrowserWindow;
    const manager = new AgentManager(() => window, settings, factory);

    await manager.activate(project);
    const sessionA = await manager.openSession(project, "/tmp/a.jsonl");
    await manager.openSession(project, "/tmp/b.jsonl");
    const sessionAAgain = await manager.openSession(project, "/tmp/a.jsonl");

    expect(runtimes).toHaveLength(3);
    expect(sessionAAgain.runtimeId).toBe(sessionA.runtimeId);

    callbacks[1]({ type: "agent_start" });
    expect(send).toHaveBeenCalledWith("agent:event", {
      projectId: project.id,
      runtimeId: sessionA.runtimeId,
      event: { type: "agent_start" },
    });

    destroyed = true;
    callbacks[1]({ type: "agent_settled" });
    expect(send).toHaveBeenCalledTimes(1);

    manager.dispose();
    expect(runtimes.every((runtime) => !runtime.isAlive)).toBe(true);
  });
});
