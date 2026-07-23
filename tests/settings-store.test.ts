import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings-store";

const temporaryDirectories: string[] = [];
const originalPiPath = process.env.PI_DESKTOP_PI_PATH;
const originalNodePath = process.env.PI_DESKTOP_NODE_PATH;
const originalPath = process.env.PATH;
const currentEnvironment = async () => ({ ...process.env });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  if (originalPiPath === undefined) delete process.env.PI_DESKTOP_PI_PATH;
  else process.env.PI_DESKTOP_PI_PATH = originalPiPath;
  if (originalNodePath === undefined) delete process.env.PI_DESKTOP_NODE_PATH;
  else process.env.PI_DESKTOP_NODE_PATH = originalNodePath;
  process.env.PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SettingsStore", () => {
  it("resolves the bundled RPC entry through Electron's Node runtime", async () => {
    const store = new SettingsStore(await temporaryDirectory(), currentEnvironment);
    await store.update({ agentSource: "bundled" });

    const launch = await store.launchSpec();
    expect(launch.rpcEntry).toBe(true);
    expect(launch.argumentPrefix[0]).toMatch(/pi-coding-agent.+rpc-entry\.js$/);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("launches a shebang-based System Pi with an absolute Node path under Finder's minimal PATH", async () => {
    const directory = await temporaryDirectory();
    const piPath = join(directory, "pi");
    const nodePath = join(directory, "node");
    await writeFile(piPath, "#!/usr/bin/env node\nconsole.log('9.9.9')\n");
    await chmod(piPath, 0o755);
    await symlink(process.execPath, nodePath);
    process.env.PI_DESKTOP_PI_PATH = piPath;
    delete process.env.PI_DESKTOP_NODE_PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

    const store = new SettingsStore(directory, async () => ({
      PATH: "/shell/bin",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    }));
    const launch = await store.launchSpec();
    expect(launch.executable).toBe(nodePath);
    expect(launch.argumentPrefix).toEqual([piPath]);
    expect(launch.env.PATH?.split(":")).toContain(directory);
    expect(launch.env.PATH?.split(":")).toContain("/shell/bin");
    expect(launch.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect((await store.status()).version).toBe("9.9.9");
  });

  it("validates and persists a custom executable", async () => {
    const directory = await temporaryDirectory();
    const executable = join(directory, "pi-custom");
    await writeFile(executable, "#!/bin/sh\necho 1.0.0\n");
    await chmod(executable, 0o755);
    const store = new SettingsStore(directory, currentEnvironment);

    await store.update({ agentSource: "custom", customPiPath: executable });
    expect(await store.get()).toEqual({ agentSource: "custom", customPiPath: executable });
    expect((await store.launchSpec()).executable).toBe(executable);
  });
});
