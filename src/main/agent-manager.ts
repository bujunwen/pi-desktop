import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type {
  ExtensionUiResponse,
  ImageContent,
  ProjectActivation,
  ProjectRecord,
  RpcRecord,
  ThinkingLevel,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { AgentRpcProcess, type AgentSnapshot } from "./agent-rpc-process";
import type { AgentLaunchSpec, SettingsStore } from "./settings-store";

interface PendingDelta {
  event: RpcRecord;
  deltaType: string;
  delta: string;
  timer: NodeJS.Timeout;
}

export interface AgentRuntime {
  readonly isAlive: boolean;
  activate(): Promise<AgentSnapshot>;
  snapshot(): Promise<AgentSnapshot>;
  getModels(): Promise<Record<string, unknown>[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  getThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getTree(): Promise<Record<string, unknown>>;
  getSessionStats(): Promise<Record<string, unknown>>;
  runBash(command: string): Promise<Record<string, unknown>>;
  prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  runBuiltin(command: string, args: string): Promise<unknown>;
  respondExtensionUi(response: ExtensionUiResponse): void;
  dispose(): void;
}

export type AgentRuntimeFactory = (
  project: ProjectRecord,
  launch: AgentLaunchSpec,
  onEvent: (event: RpcRecord) => void,
  sessionPath?: string | null,
) => AgentRuntime;

const defaultFactory: AgentRuntimeFactory = (project, launch, onEvent, sessionPath) =>
  new AgentRpcProcess(project, launch, onEvent, sessionPath);

export class AgentManager {
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #runtimeProjects = new Map<string, string>();
  readonly #activeByProject = new Map<string, string>();
  readonly #latestActivationRequests = new Map<string, number>();
  readonly #runtimeBySession = new Map<string, string>();
  readonly #sessionByRuntime = new Map<string, string>();
  readonly #pendingDeltas = new Map<string, PendingDelta>();
  readonly #getWindow: () => BrowserWindow | undefined;
  readonly #settings: SettingsStore;
  readonly #factory: AgentRuntimeFactory;

  constructor(
    getWindow: () => BrowserWindow | undefined,
    settings: SettingsStore,
    factory: AgentRuntimeFactory = defaultFactory,
  ) {
    this.#getWindow = getWindow;
    this.#settings = settings;
    this.#factory = factory;
  }

  get(projectId: string): AgentRuntime {
    const runtimeId = this.#activeByProject.get(projectId);
    const runtime = runtimeId ? this.#runtimes.get(runtimeId) : undefined;
    if (!runtime?.isAlive) throw new Error(`Project agent is not active: ${projectId}`);
    return runtime;
  }

  getRuntime(runtimeId: string): AgentRuntime {
    const runtime = this.#runtimes.get(runtimeId);
    if (!runtime?.isAlive) throw new Error(`Session agent is not active: ${runtimeId}`);
    return runtime;
  }

  requestActivation(projectId: string, requestId: number): void {
    const latest = this.#latestActivationRequests.get(projectId) ?? 0;
    if (requestId > latest) this.#latestActivationRequests.set(projectId, requestId);
  }

  async activate(project: ProjectRecord, requestId: number): Promise<ProjectActivation> {
    const activeId = this.#activeByProject.get(project.id);
    const active = activeId ? this.#runtimes.get(activeId) : undefined;
    if (active?.isAlive) return this.#activation(activeId!, await active.snapshot());

    const { runtimeId, runtime } = await this.#create(project);
    const activation = this.#activation(runtimeId, await runtime.activate());
    if (this.#isCurrentActivation(project.id, requestId)) {
      this.#activeByProject.set(project.id, runtimeId);
    }
    return activation;
  }

  async startNewSession(project: ProjectRecord, requestId: number): Promise<ProjectActivation> {
    const { runtimeId, runtime } = await this.#create(project, null);
    const activation = this.#activation(runtimeId, await runtime.activate());
    if (this.#isCurrentActivation(project.id, requestId)) {
      this.#activeByProject.set(project.id, runtimeId);
    }
    return activation;
  }

  async openSession(
    project: ProjectRecord,
    sessionPath: string,
    requestId: number,
  ): Promise<ProjectActivation> {
    const sessionKey = this.#sessionKey(project.id, sessionPath);
    let runtimeId = this.#runtimeBySession.get(sessionKey);
    let runtime = runtimeId ? this.#runtimes.get(runtimeId) : undefined;

    if (!runtime?.isAlive) {
      const created = await this.#create(project, sessionPath);
      runtimeId = created.runtimeId;
      runtime = created.runtime;
    }

    const activation = this.#activation(runtimeId!, await runtime.activate());
    if (this.#isCurrentActivation(project.id, requestId)) {
      this.#activeByProject.set(project.id, runtimeId!);
    }
    return activation;
  }

  removeProject(projectId: string): void {
    for (const [runtimeId, ownerProjectId] of this.#runtimeProjects) {
      if (ownerProjectId !== projectId) continue;
      this.#disposeRuntime(runtimeId);
    }
    this.#activeByProject.delete(projectId);
    this.#latestActivationRequests.delete(projectId);
  }

  removeSession(projectId: string, sessionPath: string): void {
    const runtimeId = this.#runtimeBySession.get(this.#sessionKey(projectId, sessionPath));
    if (!runtimeId) return;
    this.#disposeRuntime(runtimeId);
    if (this.#activeByProject.get(projectId) === runtimeId) {
      this.#activeByProject.delete(projectId);
    }
  }

  dispose(): void {
    for (const pending of this.#pendingDeltas.values()) clearTimeout(pending.timer);
    this.#pendingDeltas.clear();
    for (const runtime of this.#runtimes.values()) runtime.dispose();
    this.#runtimes.clear();
    this.#runtimeProjects.clear();
    this.#activeByProject.clear();
    this.#latestActivationRequests.clear();
    this.#runtimeBySession.clear();
    this.#sessionByRuntime.clear();
  }

  async #create(project: ProjectRecord, sessionPath?: string | null): Promise<{ runtimeId: string; runtime: AgentRuntime }> {
    const runtimeId = randomUUID();
    const launch = await this.#settings.launchSpec();
    const runtime = this.#factory(
      project,
      launch,
      (event) => this.#forward(project.id, runtimeId, event),
      sessionPath,
    );
    this.#runtimes.set(runtimeId, runtime);
    this.#runtimeProjects.set(runtimeId, project.id);
    return { runtimeId, runtime };
  }

  #activation(runtimeId: string, snapshot: AgentSnapshot): ProjectActivation {
    const sessionPath = typeof snapshot.state.sessionFile === "string" ? snapshot.state.sessionFile : undefined;
    if (sessionPath) this.#bindSession(runtimeId, snapshot.project.id, sessionPath);
    return { ...snapshot, runtimeId };
  }

  #bindSession(runtimeId: string, projectId: string, sessionPath: string): void {
    const previousPath = this.#sessionByRuntime.get(runtimeId);
    if (previousPath && previousPath !== sessionPath) {
      this.#runtimeBySession.delete(this.#sessionKey(projectId, previousPath));
    }
    this.#sessionByRuntime.set(runtimeId, sessionPath);
    this.#runtimeBySession.set(this.#sessionKey(projectId, sessionPath), runtimeId);
  }

  #sessionKey(projectId: string, sessionPath: string): string {
    return `${projectId}\u0000${sessionPath}`;
  }

  #isCurrentActivation(projectId: string, requestId: number): boolean {
    return this.#latestActivationRequests.get(projectId) === requestId;
  }

  #disposeRuntime(runtimeId: string): void {
    const runtime = this.#runtimes.get(runtimeId);
    runtime?.dispose();
    this.#runtimes.delete(runtimeId);
    const projectId = this.#runtimeProjects.get(runtimeId);
    this.#runtimeProjects.delete(runtimeId);
    const sessionPath = this.#sessionByRuntime.get(runtimeId);
    if (projectId && sessionPath) this.#runtimeBySession.delete(this.#sessionKey(projectId, sessionPath));
    this.#sessionByRuntime.delete(runtimeId);
    const pending = this.#pendingDeltas.get(runtimeId);
    if (pending) clearTimeout(pending.timer);
    this.#pendingDeltas.delete(runtimeId);
  }

  #forward(projectId: string, runtimeId: string, event: RpcRecord): void {
    const update = event.type === "message_update"
      ? event.assistantMessageEvent as Record<string, unknown> | undefined
      : undefined;
    const isDelta = update?.type === "text_delta" || update?.type === "thinking_delta";

    if (!isDelta) {
      this.#flushDelta(projectId, runtimeId);
      this.#send(projectId, runtimeId, event);
      return;
    }

    const deltaType = String(update.type);
    const existing = this.#pendingDeltas.get(runtimeId);
    if (existing && existing.deltaType === deltaType) {
      existing.event = event;
      existing.delta += String(update.delta ?? "");
      return;
    }
    if (existing) this.#flushDelta(projectId, runtimeId);

    this.#pendingDeltas.set(runtimeId, {
      event,
      deltaType,
      delta: String(update.delta ?? ""),
      timer: setTimeout(() => this.#flushDelta(projectId, runtimeId), 16),
    });
  }

  #flushDelta(projectId: string, runtimeId: string): void {
    const pending = this.#pendingDeltas.get(runtimeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingDeltas.delete(runtimeId);
    const update = pending.event.assistantMessageEvent as Record<string, unknown>;
    this.#send(projectId, runtimeId, {
      ...pending.event,
      assistantMessageEvent: { ...update, delta: pending.delta },
    });
  }

  #send(projectId: string, runtimeId: string, event: RpcRecord): void {
    const window = this.#getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.agentEvent, { projectId, runtimeId, event });
  }
}
