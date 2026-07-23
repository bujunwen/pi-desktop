import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectActivation, ProjectRecord } from "../src/shared/contracts";
import { consecutiveToolGroups, initialAppState, useAppStore } from "../src/renderer/src/store";

const project: ProjectRecord = {
  id: "project-1",
  name: "Example",
  path: "/tmp/example",
  trust: "trusted",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
};

function activation(runtimeId: string, sessionFile: string): ProjectActivation {
  return {
    project,
    runtimeId,
    state: {
      type: "state",
      sessionFile,
      thinkingLevel: "medium",
      isStreaming: false,
      model: { id: "model-1" },
    },
    messages: [],
    commands: [],
  };
}

beforeEach(() => {
  useAppStore.setState({
    ...initialAppState,
    projects: [project],
    sessions: {},
    activeRuntimeIds: {},
    runtimeRunning: {},
    runtimeSessions: {},
    conversations: {},
    extensionDialogs: [],
    extensionStatuses: {},
    extensionWidgets: {},
    runtimeEditorRequests: {},
    extensionTitles: {},
    activeProjectId: undefined,
    activeDialog: undefined,
    settings: undefined,
  });
});

describe("renderer store", () => {
  it("keeps tool activity in its chronological position", () => {
    const tool = (id: string) => ({
      id,
      kind: "tool" as const,
      name: "read",
      args: { path: `${id}.ts` },
      output: "",
      status: "success" as const,
    });
    const groups = consecutiveToolGroups([
      tool("first"),
      tool("second"),
      { id: "reply", kind: "assistant", text: "checking", thinking: "", done: true },
      tool("later"),
    ]);

    expect(groups.map((group) => group.map((item) => item.id))).toEqual([
      ["first", "second"],
      ["later"],
    ]);
  });

  it("adds a new session to the sidebar before it exists on disk", () => {
    useAppStore.getState().addPendingSession(project.id, "/tmp/new.jsonl", "hello");
    useAppStore.getState().addPendingSession(project.id, "/tmp/new.jsonl", "hello");

    expect(useAppStore.getState().sessions[project.id]).toMatchObject([
      { path: "/tmp/new.jsonl", firstMessage: "hello", messageCount: 1 },
    ]);
  });

  it("shows an immediate running state while a prompt is being accepted", () => {
    useAppStore.getState().addUserMessage(project.id, "hello");
    expect(useAppStore.getState().conversations[project.id].running).toBe(true);

    useAppStore.getState().failActivation(project.id, "failed");
    expect(useAppStore.getState().conversations[project.id].running).toBe(false);
  });

  it("routes background runtime events without polluting the active conversation", () => {
    const store = useAppStore.getState();
    store.beginActivation(project.id);
    store.applyActivation(activation("runtime-a", "/tmp/a.jsonl"));
    store.applyActivation(activation("runtime-b", "/tmp/b.jsonl"));

    store.handleAgentEvent({ projectId: project.id, runtimeId: "runtime-a", event: { type: "agent_start" } });
    expect(useAppStore.getState().runtimeRunning["runtime-a"]).toBe(true);
    expect(useAppStore.getState().conversations[project.id].running).toBe(false);
    store.handleAgentEvent({ projectId: project.id, runtimeId: "runtime-a", event: { type: "agent_settled" } });
    expect(useAppStore.getState().runtimeCompleted["runtime-a"]).toBe(true);
    useAppStore.getState().markSessionRead("/tmp/a.jsonl");
    expect(useAppStore.getState().runtimeCompleted["runtime-a"]).toBe(false);

    store.handleAgentEvent({ projectId: project.id, runtimeId: "runtime-b", event: { type: "agent_start" } });
    expect(useAppStore.getState().conversations[project.id].running).toBe(true);

    store.handleAgentEvent({ projectId: project.id, runtimeId: "runtime-b", event: { type: "agent_settled" } });
    expect(useAppStore.getState().runtimeCompleted["runtime-b"]).toBe(false);
  });

  it("queues extension dialogs with their owning runtime", () => {
    useAppStore.getState().applyActivation(activation("runtime-a", "/tmp/a.jsonl"));
    useAppStore.getState().handleAgentEvent({
      projectId: project.id,
      runtimeId: "runtime-a",
      event: {
        type: "extension_ui_request",
        id: "request-1",
        method: "confirm",
        title: "Continue?",
        message: "Confirm",
      },
    });

    expect(useAppStore.getState().extensionDialogs[0]).toMatchObject({
      projectId: project.id,
      runtimeId: "runtime-a",
      request: { id: "request-1", method: "confirm" },
    });

    useAppStore.getState().handleAgentEvent({
      projectId: project.id,
      runtimeId: "runtime-a",
      event: { type: "extension_ui_request", id: "title-1", method: "setTitle", title: "Runtime A" },
    });
    useAppStore.getState().handleAgentEvent({
      projectId: project.id,
      runtimeId: "runtime-a",
      event: { type: "extension_ui_request", id: "editor-1", method: "set_editor_text", text: "prefill" },
    });
    expect(useAppStore.getState().extensionTitles["runtime-a"]).toBe("Runtime A");
    expect(useAppStore.getState().runtimeEditorRequests["runtime-a"].text).toBe("prefill");
  });

  it("keeps image attachments on user messages", () => {
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const value = activation("runtime-a", "/tmp/a.jsonl");
    value.messages = [{ role: "user", content: [{ type: "text", text: "look" }, image] }];
    useAppStore.getState().applyActivation(value);

    expect(useAppStore.getState().conversations[project.id].items[0]).toMatchObject({
      kind: "user",
      text: "look",
      images: [image],
    });
  });

  it("restores thinking, tool output, and edit patches from history", () => {
    const value = activation("runtime-a", "/tmp/a.jsonl");
    value.messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "toolCall", id: "tool-1", name: "edit", arguments: { path: "a.ts" } },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "updated" }],
        details: { patch: "-old\n+new" },
        isError: false,
      },
    ];
    useAppStore.getState().applyActivation(value);

    const items = useAppStore.getState().conversations[project.id].items;
    expect(items).toContainEqual(expect.objectContaining({ kind: "assistant", thinking: "reason" }));
    expect(items).toContainEqual(expect.objectContaining({ kind: "assistant", text: "done" }));
    expect(items).toContainEqual(expect.objectContaining({ kind: "tool", patch: "-old\n+new", status: "success" }));
  });
});
