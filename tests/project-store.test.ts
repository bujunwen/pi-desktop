import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProjectStore", () => {
  it("persists, updates, touches, and removes projects", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectStore(directory);
    const first = await store.add("/tmp/example", "trusted");
    const updated = await store.add("/tmp/example", "untrusted");

    expect(updated.id).toBe(first.id);
    expect(updated.trust).toBe("untrusted");
    expect((await store.get(first.id)).path).toBe("/tmp/example");

    await store.touch(first.id);
    const saved = JSON.parse(await readFile(join(directory, "projects.json"), "utf8"));
    expect(saved).toHaveLength(1);

    await store.remove(first.id);
    expect(await store.list()).toEqual([]);
  });

  it("keeps pinned projects ahead of more recently opened projects", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectStore(directory);
    const first = await store.add("/tmp/first", "trusted");
    const second = await store.add("/tmp/second", "trusted");

    await store.setPinned(first.id, true);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.touch(second.id);
    expect((await store.list()).map((project) => project.id)).toEqual([first.id, second.id]);

    await store.setPinned(first.id, false);
    expect((await store.list())[0].id).toBe(second.id);
  });
});
