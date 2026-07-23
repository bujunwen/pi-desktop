import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileMatch, SessionSummary, ShellResult } from "../shared/contracts";

const execFileAsync = promisify(execFile);
const MAX_SHELL_OUTPUT_BYTES = 50 * 1024;

export async function listProjectSessions(cwd: string): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(cwd);
  return sessions.map((session) => ({
    path: session.path,
    id: session.id,
    name: session.name,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

export async function deleteProjectSession(cwd: string, sessionPath: string): Promise<void> {
  const sessions = await SessionManager.list(cwd);
  if (!sessions.some((session) => session.path === sessionPath)) {
    throw new Error("Session does not belong to this project");
  }
  await rm(sessionPath);
}

function resolveRipgrep(): string {
  const configured = process.env.PI_DESKTOP_RG_PATH;
  if (configured) return configured;
  const candidates = [
    join(homedir(), ".pi", "agent", "bin", "rg"),
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
  ];
  return candidates.find(existsSync) ?? "rg";
}

function fuzzyScore(path: string, query: string): number | undefined {
  if (!query) return 0;
  const target = path.toLowerCase();
  const needle = query.toLowerCase();
  const directIndex = target.indexOf(needle);
  if (directIndex >= 0) return directIndex + path.length / 1000;

  let needleIndex = 0;
  let gap = 0;
  let previousMatch = -1;
  for (let index = 0; index < target.length && needleIndex < needle.length; index += 1) {
    if (target[index] !== needle[needleIndex]) continue;
    if (previousMatch >= 0) gap += index - previousMatch - 1;
    previousMatch = index;
    needleIndex += 1;
  }
  return needleIndex === needle.length ? 100 + gap + path.length / 1000 : undefined;
}

export class FileSearchService {
  readonly #filesByProject = new Map<string, Promise<string[]>>();

  async search(projectPath: string, query: string): Promise<FileMatch[]> {
    const files = await this.#getFiles(projectPath);
    return files
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((match): match is FileMatch => match.score !== undefined)
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
      .slice(0, 12);
  }

  #getFiles(projectPath: string): Promise<string[]> {
    const existing = this.#filesByProject.get(projectPath);
    if (existing) return existing;

    const listing = execFileAsync(
      resolveRipgrep(),
      ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!dist", "-g", "!out"],
      { cwd: projectPath, maxBuffer: 8 * 1024 * 1024 },
    ).then(({ stdout }) => stdout.split("\n").filter(Boolean));
    this.#filesByProject.set(projectPath, listing);
    return listing;
  }
}

export function runLocalShell(cwd: string, command: string): Promise<ShellResult> {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const child = spawn(shell, ["-lc", command], { cwd, env: process.env });

  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let truncated = false;
    const append = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_SHELL_OUTPUT_BYTES) {
        output = output.subarray(output.length - MAX_SHELL_OUTPUT_BYTES);
        truncated = true;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        output: output.toString("utf8"),
        exitCode: code ?? undefined,
        cancelled: false,
        truncated,
      });
    });
  });
}
