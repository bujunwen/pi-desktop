import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SessionViewCache {
  readonly #directory: string;

  constructor(userDataPath: string) {
    this.#directory = join(userDataPath, "session-view-cache");
  }

  async get(sessionPath: string): Promise<unknown | undefined> {
    const path = this.#path(sessionPath);
    if (!existsSync(path)) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  async set(sessionPath: string, value: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const path = this.#path(sessionPath);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), "utf8");
    await rename(temporaryPath, path);
  }

  async delete(sessionPath: string): Promise<void> {
    await rm(this.#path(sessionPath), { force: true });
  }

  #path(sessionPath: string): string {
    const key = createHash("sha256").update(sessionPath).digest("hex");
    return join(this.#directory, `${key}.json`);
  }
}
