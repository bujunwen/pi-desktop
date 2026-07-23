import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ExtensionUiResponse,
  ImageContent,
  PiCommandInfo,
  ProjectActivation,
  ProjectRecord,
  RpcRecord,
  ThinkingLevel,
} from "../shared/contracts";
import { JsonlDecoder } from "./jsonl-decoder";
import type { AgentLaunchSpec } from "./settings-store";

interface PendingRequest {
  resolve(value: RpcRecord): void;
  reject(error: Error): void;
}

export type AgentSnapshot = Omit<ProjectActivation, "runtimeId">;

const BUILTIN_COMMANDS: PiCommandInfo[] = [
  { name: "new", description: "开始一个新会话", source: "builtin" },
  { name: "resume", description: "切换历史会话", source: "builtin" },
  { name: "model", description: "选择模型", source: "builtin" },
  { name: "thinking", description: "设置思考级别", source: "builtin" },
  { name: "tree", description: "查看当前会话树", source: "builtin" },
  { name: "compact", description: "压缩当前上下文", source: "builtin" },
  { name: "name", description: "设置当前会话名称", source: "builtin" },
  { name: "fork", description: "从指定用户消息创建分支", source: "builtin" },
  { name: "clone", description: "复制当前会话分支", source: "builtin" },
  { name: "settings", description: "打开桌面设置", source: "builtin" },
];

export class AgentRpcProcess {
  readonly #project: ProjectRecord;
  readonly #launch: AgentLaunchSpec;
  readonly #initialSessionPath?: string;
  readonly #onEvent: (event: RpcRecord) => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new JsonlDecoder<RpcRecord>();
  #process?: ChildProcessWithoutNullStreams;
  #requestSequence = 0;
  #alive = false;

  constructor(
    project: ProjectRecord,
    launch: AgentLaunchSpec,
    onEvent: (event: RpcRecord) => void,
    initialSessionPath?: string,
  ) {
    this.#project = project;
    this.#launch = launch;
    this.#onEvent = onEvent;
    this.#initialSessionPath = initialSessionPath;
  }

  get isAlive(): boolean {
    return this.#alive;
  }

  async activate(): Promise<AgentSnapshot> {
    if (!this.#alive) await this.#start();
    return this.snapshot();
  }

  async snapshot(): Promise<AgentSnapshot> {
    const [stateResponse, messagesResponse, commandsResponse] = await Promise.all([
      this.request({ type: "get_state" }),
      this.request({ type: "get_messages" }),
      this.request({ type: "get_commands" }),
    ]);

    const state = this.#dataRecord(stateResponse);
    const messagesData = this.#dataRecord(messagesResponse);
    const commandData = this.#dataRecord(commandsResponse);
    const discovered = (commandData.commands ?? []) as PiCommandInfo[];

    return {
      project: this.#project,
      state,
      messages: (messagesData.messages ?? []) as unknown[],
      commands: [...BUILTIN_COMMANDS, ...discovered],
    };
  }

  async getModels(): Promise<Record<string, unknown>[]> {
    const data = this.#dataRecord(await this.request({ type: "get_available_models" }));
    return (data.models ?? []) as Record<string, unknown>[];
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.request({ type: "set_model", provider, modelId });
  }

  async getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = this.#dataRecord(await this.request({ type: "get_available_thinking_levels" }));
    return (data.levels ?? ["off"]) as ThinkingLevel[];
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getTree(): Promise<Record<string, unknown>> {
    return this.#dataRecord(await this.request({ type: "get_tree" }));
  }

  async runBash(command: string): Promise<Record<string, unknown>> {
    return this.#dataRecord(await this.request({ type: "bash", command }));
  }

  async prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.request({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  respondExtensionUi(response: ExtensionUiResponse): void {
    if (!this.#process || !this.#alive) throw new Error("Pi agent is not running");
    this.#process.stdin.write(`${JSON.stringify(response)}\n`, "utf8");
  }

  async runBuiltin(command: string, args: string): Promise<unknown> {
    switch (command) {
      case "new":
        return this.#dataRecord(await this.request({ type: "new_session" }));
      case "compact":
        return this.#dataRecord(
          await this.request({
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          }),
        );
      case "name":
        if (!args) throw new Error("/name 需要一个会话名称");
        await this.request({ type: "set_session_name", name: args });
        return undefined;
      case "fork":
        if (!args) throw new Error("/fork 需要一个消息 Entry ID");
        return this.#dataRecord(await this.request({ type: "fork", entryId: args }));
      case "clone":
        return this.#dataRecord(await this.request({ type: "clone" }));
      default:
        throw new Error(`Unsupported built-in command: /${command}`);
    }
  }

  request(command: Record<string, unknown>): Promise<RpcRecord> {
    if (!this.#process || !this.#alive) throw new Error("Pi agent is not running");

    const id = `desktop-${++this.#requestSequence}`;
    const payload = JSON.stringify({ ...command, id });

    return new Promise<RpcRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#process?.stdin.write(`${payload}\n`, "utf8");
    });
  }

  dispose(): void {
    this.#process?.kill();
    this.#process = undefined;
    this.#alive = false;
    this.#rejectPending(new Error("Pi agent was stopped"));
  }

  async #start(): Promise<void> {
    const rpcArguments = this.#launch.rpcEntry ? [] : ["--mode", "rpc"];
    const sessionArguments = this.#initialSessionPath
      ? ["--session", this.#initialSessionPath]
      : ["--continue"];
    const args = [
      ...this.#launch.argumentPrefix,
      ...rpcArguments,
      ...sessionArguments,
      this.#project.trust === "trusted" ? "--approve" : "--no-approve",
    ];
    const child = spawn(this.#launch.executable, args, {
      cwd: this.#project.path,
      env: this.#launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const record of this.#decoder.push(chunk)) this.#handleRecord(record);
      } catch (error) {
        this.#onEvent({ type: "desktop_error", message: (error as Error).message });
        this.dispose();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.#onEvent({ type: "agent_stderr", message: chunk.toString("utf8") });
    });

    child.on("exit", (code, signal) => {
      this.#alive = false;
      this.#process = undefined;
      this.#rejectPending(new Error(`Pi agent exited (${code ?? signal ?? "unknown"})`));
      this.#onEvent({ type: "agent_process_exit", code, signal });
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        this.#alive = true;
        resolve();
      });
      child.once("error", reject);
    });
  }

  #handleRecord(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.#pending.get(record.id);
      if (!pending) return;

      this.#pending.delete(record.id);
      if (record.success === false) {
        pending.reject(new Error(String(record.error ?? "Pi RPC command failed")));
      } else {
        pending.resolve(record);
      }
      return;
    }

    this.#onEvent(record);
  }

  #dataRecord(response: RpcRecord): RpcRecord {
    return (response.data ?? {}) as RpcRecord;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
