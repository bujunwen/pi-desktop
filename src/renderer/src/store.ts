import { create } from "zustand";
import type {
  AgentEventEnvelope,
  AgentSourceStatus,
  ContextUsage,
  ImageContent,
  PiCommandInfo,
  ProjectActivation,
  ProjectRecord,
  SessionSummary,
  ShellResult,
  ThinkingLevel,
} from "../../shared/contracts";

export type ConversationItem =
  | { id: string; kind: "user"; text: string; images?: ImageContent[] }
  | { id: string; kind: "assistant"; text: string; thinking: string; done: boolean }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      output: string;
      patch?: string;
      status: "running" | "success" | "error";
    }
  | { id: string; kind: "notice"; text: string; tone: "normal" | "error" };

export type ToolItem = Extract<ConversationItem, { kind: "tool" }>;

export function consecutiveToolGroups(items: ConversationItem[]): ToolItem[][] {
  const groups: ToolItem[][] = [];
  let current: ToolItem[] | undefined;

  for (const item of items) {
    if (item.kind !== "tool") {
      if (item.kind !== "assistant" || item.text.trim()) current = undefined;
      continue;
    }
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push(item);
  }

  return groups;
}

export interface ProjectConversation {
  items: ConversationItem[];
  commands: PiCommandInfo[];
  running: boolean;
  steering: string[];
  followUp: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextUsage?: ContextUsage;
  sessionName?: string;
  sessionFile?: string;
  currentAssistantId?: string;
  runStartedAt?: number;
}

export interface ExtensionDialogRequest {
  projectId: string;
  runtimeId: string;
  request: Record<string, unknown> & { id: string; method: "select" | "confirm" | "input" | "editor" };
}

export interface ExtensionWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export type AppDialog = "model" | "thinking" | "tree" | "sessions" | "settings";

export interface AppState {
  projects: ProjectRecord[];
  sessions: Record<string, SessionSummary[]>;
  activeProjectId?: string;
  activeRuntimeIds: Record<string, string>;
  runtimeRunning: Record<string, boolean>;
  runtimeStartedAt: Record<string, number>;
  runtimeCompleted: Record<string, boolean>;
  runtimeSessions: Record<string, string>;
  activeDialog?: AppDialog;
  conversations: Record<string, ProjectConversation>;
  loadingProject: boolean;
  extensionDialogs: ExtensionDialogRequest[];
  extensionStatuses: Record<string, Record<string, string>>;
  extensionWidgets: Record<string, Record<string, ExtensionWidget>>;
  runtimeEditorRequests: Record<string, { text: string; nonce: number }>;
  extensionTitles: Record<string, string>;
  settings?: AgentSourceStatus;
  setProjects(projects: ProjectRecord[]): void;
  setSessions(projectId: string, sessions: SessionSummary[]): void;
  addPendingSession(projectId: string, sessionPath: string, firstMessage: string): void;
  removeSession(projectId: string, sessionPath: string): void;
  setSettings(settings: AgentSourceStatus): void;
  addProject(project: ProjectRecord): void;
  removeProject(projectId: string): void;
  openDialog(dialog: AppDialog): void;
  closeDialog(): void;
  dismissExtensionDialog(id: string): void;
  markSessionRead(sessionPath: string): void;
  beginActivation(projectId: string): void;
  showCachedSession(projectId: string, sessionPath: string, conversation: ProjectConversation): void;
  applyActivation(activation: ProjectActivation): void;
  failActivation(projectId: string, message: string): void;
  addUserMessage(projectId: string, text: string, images?: ImageContent[]): void;
  addShellResult(projectId: string, command: string, result: ShellResult, included: boolean): void;
  clearConversation(projectId: string): void;
  updateContextUsage(projectId: string, runtimeId: string, contextUsage?: ContextUsage): void;
  handleAgentEvent(envelope: AgentEventEnvelope): void;
}

export const emptyConversation = (): ProjectConversation => ({
  items: [],
  commands: [],
  running: false,
  steering: [],
  followUp: [],
});

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("");
}

function imagesFromContent(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is ImageContent => Boolean(
      block
      && typeof block === "object"
      && (block as ImageContent).type === "image"
      && typeof (block as ImageContent).data === "string"
      && typeof (block as ImageContent).mimeType === "string",
    ));
}

export function historyItems(messages: unknown[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const tools = new Map<string, number>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = message.role;

    if (role === "user") {
      const images = imagesFromContent(message.content);
      items.push({
        id: `history-user-${items.length}`,
        kind: "user",
        text: textFromContent(message.content),
        ...(images.length ? { images } : {}),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(message.content)) {
      let text = "";
      let thinking = "";
      const flushAssistant = () => {
        if (!text && !thinking) return;
        items.push({
          id: `history-assistant-${items.length}`,
          kind: "assistant",
          text,
          thinking,
          done: true,
        });
        text = "";
        thinking = "";
      };
      for (const rawBlock of message.content) {
        const block = rawBlock as Record<string, unknown>;
        if (block.type === "text") text += String(block.text ?? "");
        if (block.type === "thinking") thinking += String(block.thinking ?? "");
        if (block.type === "toolCall") {
          flushAssistant();
          const id = String(block.id ?? `history-tool-${items.length}`);
          tools.set(id, items.length);
          items.push({
            id,
            kind: "tool",
            name: String(block.name ?? "tool"),
            args: (block.arguments ?? {}) as Record<string, unknown>,
            output: "",
            status: "running",
          });
        }
      }
      flushAssistant();
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = String(message.toolCallId ?? "");
      const index = tools.get(toolCallId);
      if (index === undefined) continue;
      const current = items[index];
      if (current.kind !== "tool") continue;
      const details = (message.details ?? {}) as Record<string, unknown>;
      items[index] = {
        ...current,
        output: textFromContent(message.content),
        patch: typeof details.patch === "string" ? details.patch : undefined,
        status: message.isError ? "error" : "success",
      };
    }
  }

  return items;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  return textFromContent((result as Record<string, unknown>).content);
}

function resultPatch(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = ((result as Record<string, unknown>).details ?? {}) as Record<string, unknown>;
  return typeof details.patch === "string" ? details.patch : undefined;
}

export const initialAppState = {
  projects: [],
  sessions: {},
  activeRuntimeIds: {},
  runtimeRunning: {},
  runtimeStartedAt: {},
  runtimeCompleted: {},
  runtimeSessions: {},
  conversations: {},
  loadingProject: false,
  extensionDialogs: [],
  extensionStatuses: {},
  extensionWidgets: {},
  runtimeEditorRequests: {},
  extensionTitles: {},
} satisfies Partial<AppState>;

export const useAppStore = create<AppState>((set) => ({
  ...initialAppState,

  setProjects: (projects) => set({ projects }),

  setSessions: (projectId, sessions) =>
    set((state) => ({ sessions: { ...state.sessions, [projectId]: sessions } })),

  addPendingSession: (projectId, sessionPath, firstMessage) =>
    set((state) => {
      const sessions = state.sessions[projectId] ?? [];
      if (sessions.some((session) => session.path === sessionPath)) return state;
      const now = new Date().toISOString();
      return {
        sessions: {
          ...state.sessions,
          [projectId]: [{
            path: sessionPath,
            id: sessionPath,
            createdAt: now,
            modifiedAt: now,
            messageCount: 1,
            firstMessage,
          }, ...sessions],
        },
      };
    }),

  removeSession: (projectId, sessionPath) =>
    set((state) => {
      const removedRuntimeIds = Object.keys(state.runtimeSessions)
        .filter((runtimeId) => state.runtimeSessions[runtimeId] === sessionPath);
      const runtimeSessions = { ...state.runtimeSessions };
      const runtimeRunning = { ...state.runtimeRunning };
      const runtimeStartedAt = { ...state.runtimeStartedAt };
      const runtimeCompleted = { ...state.runtimeCompleted };
      const activeRuntimeIds = { ...state.activeRuntimeIds };
      for (const runtimeId of removedRuntimeIds) {
        delete runtimeSessions[runtimeId];
        delete runtimeRunning[runtimeId];
        delete runtimeStartedAt[runtimeId];
        delete runtimeCompleted[runtimeId];
        if (activeRuntimeIds[projectId] === runtimeId) delete activeRuntimeIds[projectId];
      }
      const conversation = state.conversations[projectId];
      const removedActiveConversation = state.activeProjectId === projectId
        && conversation?.sessionFile === sessionPath;
      return {
        sessions: {
          ...state.sessions,
          [projectId]: (state.sessions[projectId] ?? [])
            .filter((session) => session.path !== sessionPath),
        },
        runtimeSessions,
        runtimeRunning,
        runtimeStartedAt,
        runtimeCompleted,
        activeRuntimeIds,
        activeProjectId: removedActiveConversation ? undefined : state.activeProjectId,
        conversations: removedActiveConversation
          ? { ...state.conversations, [projectId]: emptyConversation() }
          : state.conversations,
      };
    }),

  setSettings: (settings) => set({ settings }),

  addProject: (project) =>
    set((state) => ({
      projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
    })),

  removeProject: (projectId) =>
    set((state) => {
      const projects = state.projects.filter((project) => project.id !== projectId);
      const conversations = { ...state.conversations };
      const sessions = { ...state.sessions };
      const activeRuntimeIds = { ...state.activeRuntimeIds };
      delete conversations[projectId];
      delete sessions[projectId];
      delete activeRuntimeIds[projectId];
      return {
        projects,
        conversations,
        sessions,
        activeRuntimeIds,
        activeProjectId: state.activeProjectId === projectId ? undefined : state.activeProjectId,
      };
    }),

  openDialog: (activeDialog) => set({ activeDialog }),

  closeDialog: () => set({ activeDialog: undefined }),

  dismissExtensionDialog: (id) =>
    set((state) => ({ extensionDialogs: state.extensionDialogs.filter((item) => item.request.id !== id) })),

  markSessionRead: (sessionPath) =>
    set((state) => {
      const runtimeId = Object.keys(state.runtimeSessions)
        .find((id) => state.runtimeSessions[id] === sessionPath);
      if (!runtimeId) return state;
      return { runtimeCompleted: { ...state.runtimeCompleted, [runtimeId]: false } };
    }),

  beginActivation: (projectId) =>
    set((state) => {
      const activeRuntimeIds = { ...state.activeRuntimeIds };
      delete activeRuntimeIds[projectId];
      return {
        activeProjectId: projectId,
        activeRuntimeIds,
        loadingProject: true,
        conversations: {
          ...state.conversations,
          [projectId]: emptyConversation(),
        },
      };
    }),

  showCachedSession: (projectId, sessionPath, conversation) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [projectId]: {
          ...conversation,
          sessionFile: sessionPath,
          running: false,
          steering: [],
          followUp: [],
          currentAssistantId: undefined,
        },
      },
    })),

  applyActivation: (activation) =>
    set((state) => {
      const data = activation.state as Record<string, unknown>;
      const model = data.model as Record<string, unknown> | null;
      return {
        loadingProject: false,
        activeDialog: undefined,
        activeRuntimeIds: {
          ...state.activeRuntimeIds,
          [activation.project.id]: activation.runtimeId,
        },
        runtimeRunning: {
          ...state.runtimeRunning,
          [activation.runtimeId]: Boolean(data.isStreaming),
        },
        runtimeStartedAt: Boolean(data.isStreaming)
          ? {
              ...state.runtimeStartedAt,
              [activation.runtimeId]: state.runtimeStartedAt[activation.runtimeId] ?? Date.now(),
            }
          : state.runtimeStartedAt,
        runtimeSessions: typeof data.sessionFile === "string"
          ? { ...state.runtimeSessions, [activation.runtimeId]: data.sessionFile }
          : state.runtimeSessions,
        conversations: {
          ...state.conversations,
          [activation.project.id]: {
            ...(state.conversations[activation.project.id] ?? emptyConversation()),
            items: historyItems(activation.messages),
            commands: activation.commands,
            running: Boolean(data.isStreaming),
            steering: [],
            followUp: [],
            model: model ? String(model.id ?? "") : undefined,
            thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel as ThinkingLevel : undefined,
            contextUsage: data.contextUsage as ContextUsage | undefined,
            sessionName: typeof data.sessionName === "string" ? data.sessionName : undefined,
            sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
            currentAssistantId: undefined,
            runStartedAt: Boolean(data.isStreaming)
              ? state.runtimeStartedAt[activation.runtimeId] ?? Date.now()
              : undefined,
          },
        },
      };
    }),

  failActivation: (projectId, message) =>
    set((state) => ({
      loadingProject: false,
      conversations: {
        ...state.conversations,
        [projectId]: {
          ...(state.conversations[projectId] ?? emptyConversation()),
          running: false,
          items: [
            ...(state.conversations[projectId]?.items ?? []),
            { id: crypto.randomUUID(), kind: "notice", text: message, tone: "error" },
          ],
        },
      },
    })),

  addUserMessage: (projectId, text, images) =>
    set((state) => {
      const conversation = state.conversations[projectId] ?? emptyConversation();
      const runtimeId = state.activeRuntimeIds[projectId];
      const startedAt = Date.now();
      return {
        runtimeStartedAt: runtimeId
          ? { ...state.runtimeStartedAt, [runtimeId]: startedAt }
          : state.runtimeStartedAt,
        conversations: {
          ...state.conversations,
          [projectId]: {
            ...conversation,
            running: true,
            runStartedAt: startedAt,
            items: [...conversation.items, {
              id: crypto.randomUUID(),
              kind: "user",
              text,
              ...(images?.length ? { images } : {}),
            }],
          },
        },
      };
    }),

  addShellResult: (projectId, command, result, included) =>
    set((state) => {
      const conversation = state.conversations[projectId] ?? emptyConversation();
      return {
        conversations: {
          ...state.conversations,
          [projectId]: {
            ...conversation,
            items: [
              ...conversation.items,
              {
                id: crypto.randomUUID(),
                kind: "tool",
                name: included ? "!" : "!!",
                args: { command },
                output: result.output,
                status: result.exitCode === 0 ? "success" : "error",
              },
            ],
          },
        },
      };
    }),

  clearConversation: (projectId) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [projectId]: {
          ...(state.conversations[projectId] ?? emptyConversation()),
          items: [],
          steering: [],
          followUp: [],
          currentAssistantId: undefined,
        },
      },
    })),

  updateContextUsage: (projectId, runtimeId, contextUsage) =>
    set((state) => {
      if (state.activeRuntimeIds[projectId] !== runtimeId) return state;
      const conversation = state.conversations[projectId];
      if (!conversation) return state;
      return {
        conversations: {
          ...state.conversations,
          [projectId]: { ...conversation, contextUsage },
        },
      };
    }),

  handleAgentEvent: ({ projectId, runtimeId, event }) =>
    set((state) => {
      let extensionDialogs = state.extensionDialogs;
      let extensionStatuses = state.extensionStatuses;
      let extensionWidgets = state.extensionWidgets;
      let runtimeEditorRequests = state.runtimeEditorRequests;
      let extensionTitles = state.extensionTitles;
      const runtimeRunning = { ...state.runtimeRunning };
      const runtimeStartedAt = { ...state.runtimeStartedAt };
      const runtimeCompleted = { ...state.runtimeCompleted };

      if (event.type === "agent_start") {
        runtimeRunning[runtimeId] = true;
        runtimeStartedAt[runtimeId] ??= Date.now();
        runtimeCompleted[runtimeId] = false;
      }
      if (event.type === "agent_settled" || event.type === "agent_process_exit") {
        runtimeRunning[runtimeId] = false;
        delete runtimeStartedAt[runtimeId];
      }
      if (event.type === "agent_settled") {
        const isVisible = state.activeProjectId === projectId
          && state.activeRuntimeIds[projectId] === runtimeId;
        runtimeCompleted[runtimeId] = !isVisible;
      }
      if (event.type === "agent_process_exit") {
        extensionDialogs = state.extensionDialogs.filter((item) => item.runtimeId !== runtimeId);
      }

      if (event.type === "extension_ui_request") {
        const method = String(event.method);
        if (["select", "confirm", "input", "editor"].includes(method)) {
          extensionDialogs = [
            ...state.extensionDialogs.filter((item) => item.request.id !== event.id),
            {
              projectId,
              runtimeId,
              request: event as unknown as ExtensionDialogRequest["request"],
            },
          ];
        }
        if (method === "setStatus") {
          const statuses = { ...(state.extensionStatuses[runtimeId] ?? {}) };
          if (typeof event.statusText === "string") statuses[String(event.statusKey)] = event.statusText;
          else delete statuses[String(event.statusKey)];
          extensionStatuses = { ...state.extensionStatuses, [runtimeId]: statuses };
        }
        if (method === "setWidget") {
          const widgets = { ...(state.extensionWidgets[runtimeId] ?? {}) };
          if (Array.isArray(event.widgetLines)) {
            widgets[String(event.widgetKey)] = {
              lines: event.widgetLines.map(String),
              placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
            };
          } else delete widgets[String(event.widgetKey)];
          extensionWidgets = { ...state.extensionWidgets, [runtimeId]: widgets };
        }
        if (method === "setTitle" && typeof event.title === "string") {
          extensionTitles = { ...state.extensionTitles, [runtimeId]: event.title };
        }
        if (method === "set_editor_text") {
          runtimeEditorRequests = {
            ...state.runtimeEditorRequests,
            [runtimeId]: { text: String(event.text ?? ""), nonce: Date.now() },
          };
        }
      }

      const base = {
        runtimeRunning,
        runtimeStartedAt,
        runtimeCompleted,
        extensionDialogs,
        extensionStatuses,
        extensionWidgets,
        runtimeEditorRequests,
        extensionTitles,
      };
      if (state.activeRuntimeIds[projectId] !== runtimeId) return base;

      const conversation = state.conversations[projectId] ?? emptyConversation();
      const next: ProjectConversation = { ...conversation, items: [...conversation.items] };

      switch (event.type) {
        case "agent_start":
          next.running = true;
          next.runStartedAt ??= runtimeStartedAt[runtimeId];
          break;
        case "agent_settled":
          next.running = false;
          next.currentAssistantId = undefined;
          next.runStartedAt = undefined;
          break;
        case "message_update": {
          const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!update || (update.type !== "text_delta" && update.type !== "thinking_delta")) break;

          let assistantId = next.currentAssistantId;
          let index = assistantId ? next.items.findIndex((item) => item.id === assistantId) : -1;
          if (index === -1) {
            assistantId = crypto.randomUUID();
            next.currentAssistantId = assistantId;
            next.items.push({ id: assistantId, kind: "assistant", text: "", thinking: "", done: false });
            index = next.items.length - 1;
          }

          const item = next.items[index];
          if (item.kind !== "assistant") break;
          next.items[index] = {
            ...item,
            text: update.type === "text_delta" ? item.text + String(update.delta ?? "") : item.text,
            thinking: update.type === "thinking_delta" ? item.thinking + String(update.delta ?? "") : item.thinking,
          };
          break;
        }
        case "message_end": {
          if (!next.currentAssistantId) break;
          const index = next.items.findIndex((item) => item.id === next.currentAssistantId);
          const item = next.items[index];
          if (item?.kind === "assistant") next.items[index] = { ...item, done: true };
          next.currentAssistantId = undefined;
          break;
        }
        case "tool_execution_start":
          next.items.push({
            id: String(event.toolCallId),
            kind: "tool",
            name: String(event.toolName),
            args: (event.args ?? {}) as Record<string, unknown>,
            output: "",
            status: "running",
          });
          break;
        case "tool_execution_update": {
          const index = next.items.findIndex((item) => item.id === String(event.toolCallId));
          const item = next.items[index];
          if (item?.kind === "tool") next.items[index] = { ...item, output: resultText(event.partialResult) };
          break;
        }
        case "tool_execution_end": {
          const index = next.items.findIndex((item) => item.id === String(event.toolCallId));
          const item = next.items[index];
          if (item?.kind === "tool") {
            next.items[index] = {
              ...item,
              output: resultText(event.result),
              patch: resultPatch(event.result),
              status: event.isError ? "error" : "success",
            };
          }
          break;
        }
        case "queue_update":
          next.steering = (event.steering ?? []) as string[];
          next.followUp = (event.followUp ?? []) as string[];
          break;
        case "model_select": {
          const model = event.model as Record<string, unknown> | undefined;
          if (model) next.model = String(model.id ?? "");
          break;
        }
        case "thinking_level_changed":
          next.thinkingLevel = event.level as ThinkingLevel;
          break;
        case "session_info_changed":
          next.sessionName = typeof event.name === "string" ? event.name : undefined;
          break;
        case "extension_ui_request":
          if (event.method === "notify") {
            next.items.push({
              id: crypto.randomUUID(),
              kind: "notice",
              text: String(event.message ?? ""),
              tone: event.notifyType === "error" ? "error" : "normal",
            });
          }
          break;
        case "extension_error":
          next.items.push({
            id: crypto.randomUUID(),
            kind: "notice",
            text: String(event.error ?? "Extension error"),
            tone: "error",
          });
          break;
        case "agent_process_exit":
          next.running = false;
          next.items.push({ id: crypto.randomUUID(), kind: "notice", text: "Pi Agent 进程已退出", tone: "error" });
          break;
        case "desktop_error":
          next.items.push({
            id: crypto.randomUUID(),
            kind: "notice",
            text: String(event.message ?? "Unknown desktop error"),
            tone: "error",
          });
          break;
      }

      return { ...base, conversations: { ...state.conversations, [projectId]: next } };
    }),
}));
