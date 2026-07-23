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

    manager.requestActivation(project.id, 1);
    await manager.activate(project, 1);
    manager.requestActivation(project.id, 2);
    const sessionA = await manager.openSession(project, "/tmp/a.jsonl", 2);
    manager.requestActivation(project.id, 3);
    await manager.openSession(project, "/tmp/b.jsonl", 3);
    manager.requestActivation(project.id, 4);
    const sessionAAgain = await manager.openSession(project, "/tmp/a.jsonl", 4);

    expect(runtimes).toHaveLength(3);
    expect(sessionAAgain.runtimeId).toBe(sessionA.runtimeId);

    callbacks[1]({ type: "agent_start" });
    expect(send).toHaveBeenCalledWith("agent:event", {
      projectId: project.id,
      runtimeId: sessionA.runtimeId,
      event: { type: "agent_start" },
    });

    manager.requestActivation(project.id, 5);
    await manager.openSession(project, "/tmp/b.jsonl", 5);
    manager.requestActivation(project.id, 4);
    await manager.openSession(project, "/tmp/a.jsonl", 4);
    expect(manager.get(project.id)).toBe(runtimes[2]);

    manager.removeSession(project.id, "/tmp/a.jsonl");
    manager.requestActivation(project.id, 6);
    const reopenedSessionA = await manager.openSession(project, "/tmp/a.jsonl", 6);
    expect(runtimes).toHaveLength(4);
    expect(reopenedSessionA.runtimeId).not.toBe(sessionA.runtimeId);

    destroyed = true;
    callbacks[1]({ type: "agent_settled" });
    expect(send).toHaveBeenCalledTimes(1);

    manager.dispose();
    expect(runtimes.every((runtime) => !runtime.isAlive)).toBe(true);
  });
});
