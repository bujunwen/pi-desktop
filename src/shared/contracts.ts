export type ProjectTrust = "trusted" | "untrusted";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSource = "system" | "bundled" | "custom";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  trust: ProjectTrust;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
}

export interface AppSettings {
  agentSource: AgentSource;
  customPiPath?: string;
}

export interface AgentSourceStatus extends AppSettings {
  resolvedPath: string;
  version: string;
  bundledVersion: string;
}

export interface PiCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

export type RpcRecord = Record<string, unknown> & { type: string };

export interface SessionSummary {
  path: string;
  id: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage: string;
}

export interface FileMatch {
  path: string;
  score: number;
}

export interface ShellResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

export interface AgentEventEnvelope {
  projectId: string;
  runtimeId: string;
  event: RpcRecord;
}

export interface ProjectActivation {
  project: ProjectRecord;
  runtimeId: string;
  state: RpcRecord;
  messages: unknown[];
  commands: PiCommandInfo[];
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptInput {
  projectId: string;
  message: string;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
}

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface DesktopApi {
  projects: {
    list(): Promise<ProjectRecord[]>;
    add(): Promise<ProjectRecord | undefined>;
    remove(projectId: string): Promise<void>;
    setPinned(projectId: string, pinned: boolean): Promise<ProjectRecord[]>;
    reveal(projectId: string): Promise<void>;
    activate(projectId: string): Promise<ProjectActivation>;
    listSessions(projectId: string): Promise<SessionSummary[]>;
    switchSession(projectId: string, sessionPath: string): Promise<ProjectActivation>;
    searchFiles(projectId: string, query: string): Promise<FileMatch[]>;
  };
  agent: {
    prompt(input: PromptInput): Promise<void>;
    abort(projectId: string): Promise<void>;
    runBuiltin(projectId: string, command: string, args: string): Promise<unknown>;
    getModels(projectId: string): Promise<Record<string, unknown>[]>;
    setModel(projectId: string, provider: string, modelId: string): Promise<void>;
    getThinkingLevels(projectId: string): Promise<ThinkingLevel[]>;
    setThinkingLevel(projectId: string, level: ThinkingLevel): Promise<void>;
    getTree(projectId: string): Promise<Record<string, unknown>>;
    runShell(projectId: string, command: string, includeInContext: boolean): Promise<ShellResult>;
    respondExtensionUi(runtimeId: string, response: ExtensionUiResponse): Promise<void>;
    onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  };
  notifications: {
    taskComplete(projectName: string): Promise<{ foreground: boolean }>;
  };
  settings: {
    get(): Promise<AgentSourceStatus>;
    update(settings: AppSettings): Promise<AgentSourceStatus>;
  };
}

export const IPC = {
  projectsList: "projects:list",
  projectsAdd: "projects:add",
  projectsRemove: "projects:remove",
  projectsSetPinned: "projects:set-pinned",
  projectsReveal: "projects:reveal",
  projectsActivate: "projects:activate",
  projectsSessions: "projects:sessions",
  projectsSwitchSession: "projects:switch-session",
  projectsSearchFiles: "projects:search-files",
  agentPrompt: "agent:prompt",
  agentAbort: "agent:abort",
  agentBuiltin: "agent:builtin",
  agentModels: "agent:models",
  agentSetModel: "agent:set-model",
  agentThinkingLevels: "agent:thinking-levels",
  agentSetThinkingLevel: "agent:set-thinking-level",
  agentTree: "agent:tree",
  agentShell: "agent:shell",
  agentExtensionUiResponse: "agent:extension-ui-response",
  agentEvent: "agent:event",
  notificationTaskComplete: "notification:task-complete",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
} as const;
