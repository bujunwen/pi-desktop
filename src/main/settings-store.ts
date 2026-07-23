import { execFile } from "node:child_process";
import { findPackageJSON } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { access, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { promisify } from "node:util";
import type { AgentSourceStatus, AppSettings } from "../shared/contracts";

const execFileAsync = promisify(execFile);
const BUNDLED_PI_VERSION = "0.81.1";
const DEFAULT_SETTINGS: AppSettings = { agentSource: "system" };

export type ShellEnvironmentLoader = () => Promise<NodeJS.ProcessEnv>;
let loginShellEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

function loadLoginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  loginShellEnvironmentPromise ??= readLoginShellEnvironment();
  return loginShellEnvironmentPromise;
}

async function readLoginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "/usr/bin/env -0"], {
      cwd: homedir(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    const environment: NodeJS.ProcessEnv = {};
    for (const record of stdout.split("\0")) {
      const normalized = record.slice(record.lastIndexOf("\n") + 1);
      const separator = normalized.indexOf("=");
      if (separator <= 0) continue;
      const key = normalized.slice(0, separator);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      environment[key] = normalized.slice(separator + 1);
    }
    return environment;
  } catch {
    return {};
  }
}

async function agentEnvironment(
  loadShellEnvironment: ShellEnvironmentLoader,
  extraPaths: string[] = [],
  overrides: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> {
  const shellEnvironment = await loadShellEnvironment();
  const pathEntries = [
    ...extraPaths,
    join(homedir(), ".pi", "agent", "bin"),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...(shellEnvironment.PATH ?? "").split(":").filter(Boolean),
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
  return {
    ...process.env,
    ...shellEnvironment,
    ...overrides,
    PATH: [...new Set(pathEntries)].join(":"),
  };
}

export interface AgentLaunchSpec {
  executable: string;
  argumentPrefix: string[];
  env: NodeJS.ProcessEnv;
  displayPath: string;
  rpcEntry: boolean;
}

function systemPiPath(): string {
  const configured = process.env.PI_DESKTOP_PI_PATH;
  if (configured) return configured;
  const candidates = [
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    join(homedir(), ".local", "bin", "pi"),
    join(homedir(), ".bun", "bin", "pi"),
  ];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("未找到 System Pi，请在设置中选择 Bundled Pi 或指定 Pi 路径");
  return executable;
}

function bundledRpcEntry(): string {
  const packagePath = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (!packagePath) throw new Error("Bundled Pi package is missing");
  return join(dirname(packagePath), "dist", "rpc-entry.js");
}

async function executableShebang(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
  } finally {
    await file.close();
  }
}

async function piExecutableLaunch(
  piPath: string,
  loadShellEnvironment: ShellEnvironmentLoader,
): Promise<AgentLaunchSpec> {
  const firstLine = await executableShebang(piPath);
  if (/^#!.*\bnode(?:\s|$)/.test(firstLine)) {
    const nodePath = [
      process.env.PI_DESKTOP_NODE_PATH,
      join(dirname(piPath), "node"),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      join(homedir(), ".local", "bin", "node"),
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    if (!nodePath) throw new Error(`Pi 需要 Node.js，但未找到 Node 可执行文件：${piPath}`);
    return {
      executable: nodePath,
      argumentPrefix: [piPath],
      env: await agentEnvironment(loadShellEnvironment, [dirname(piPath), dirname(nodePath)]),
      displayPath: piPath,
      rpcEntry: false,
    };
  }

  return {
    executable: piPath,
    argumentPrefix: [],
    env: await agentEnvironment(loadShellEnvironment, [dirname(piPath)]),
    displayPath: piPath,
    rpcEntry: false,
  };
}

async function executableVersion(executable: string, argumentPrefix: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...argumentPrefix, "--version"], { env });
  return stdout.trim();
}

export class SettingsStore {
  readonly #filePath: string;
  readonly #loadShellEnvironment: ShellEnvironmentLoader;

  constructor(
    userDataPath: string,
    loadShellEnvironment: ShellEnvironmentLoader = loadLoginShellEnvironment,
  ) {
    this.#filePath = join(userDataPath, "desktop-settings.json");
    this.#loadShellEnvironment = loadShellEnvironment;
  }

  async get(): Promise<AppSettings> {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(this.#filePath, "utf8")) as AppSettings };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
      throw error;
    }
  }

  async update(settings: AppSettings): Promise<void> {
    if (settings.agentSource === "custom") {
      if (!settings.customPiPath) throw new Error("自定义 Pi 路径不能为空");
      await access(settings.customPiPath, constants.X_OK);
    }
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#filePath);
  }

  async launchSpec(): Promise<AgentLaunchSpec> {
    const settings = await this.get();
    if (settings.agentSource === "bundled") {
      const entry = bundledRpcEntry();
      return {
        executable: process.execPath,
        argumentPrefix: [entry],
        env: await agentEnvironment(this.#loadShellEnvironment, [], { ELECTRON_RUN_AS_NODE: "1" }),
        displayPath: entry,
        rpcEntry: true,
      };
    }
    const executable = settings.agentSource === "custom" ? settings.customPiPath! : systemPiPath();
    return piExecutableLaunch(executable, this.#loadShellEnvironment);
  }

  async status(): Promise<AgentSourceStatus> {
    const settings = await this.get();
    if (settings.agentSource === "system") {
      try {
        const launch = await this.launchSpec();
        return {
          ...settings,
          resolvedPath: launch.displayPath,
          version: await executableVersion(launch.executable, launch.argumentPrefix, launch.env),
          bundledVersion: BUNDLED_PI_VERSION,
        };
      } catch {
        return {
          ...settings,
          resolvedPath: "未找到 System Pi",
          version: "未安装",
          bundledVersion: BUNDLED_PI_VERSION,
        };
      }
    }

    const launch = await this.launchSpec();
    return {
      ...settings,
      resolvedPath: launch.displayPath,
      version: settings.agentSource === "bundled"
        ? BUNDLED_PI_VERSION
        : await executableVersion(launch.executable, launch.argumentPrefix, launch.env),
      bundledVersion: BUNDLED_PI_VERSION,
    };
  }
}
