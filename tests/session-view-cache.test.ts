import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionViewCache } from "../src/main/session-view-cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("SessionViewCache", () => {
  it("persists a session view by session path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-desktop-session-view-"));
    temporaryDirectories.push(directory);
    const cache = new SessionViewCache(directory);
    const sessionPath = "/tmp/project/session.jsonl";
    const view = { items: [{ id: "1", kind: "user", text: "hello" }] };

    expect(await cache.get(sessionPath)).toBeUndefined();
    await cache.set(sessionPath, view);
    expect(await cache.get(sessionPath)).toEqual(view);

    await cache.delete(sessionPath);
    expect(await cache.get(sessionPath)).toBeUndefined();
  });
});
