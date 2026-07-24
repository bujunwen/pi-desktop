import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type {
  AppSettings,
  ExtensionUiResponse,
  PromptInput,
  ShellResult,
  TaskCompleteNotification,
  ThinkingLevel,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { AgentManager } from "./agent-manager";
import {
  deleteProjectSession,
  FileSearchService,
  listProjectSessions,
  runLocalShell,
} from "./project-services";
import { ProjectStore } from "./project-store";
import { SessionViewCache } from "./session-view-cache";
import { SettingsStore } from "./settings-store";

let mainWindow: BrowserWindow | undefined;
let projectStore: ProjectStore;
let settingsStore: SettingsStore;
let sessionViewCache: SessionViewCache;
let agentManager: AgentManager;
const fileSearchService = new FileSearchService();
const activeNotifications = new Set<Notification>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#1f201e",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.once("ready-to-show", () => {
    app.focus({ steal: true });
    mainWindow?.maximize();
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.projectsList, () => projectStore.list());

  ipcMain.handle(IPC.projectsAdd, async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: "选择一个项目目录",
      properties: ["openDirectory"],
    });
    if (selection.canceled) return undefined;

    const projectPath = selection.filePaths[0];
    const trust = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: "是否信任这个项目？",
      message: "信任项目会允许 Pi 加载项目内的设置、Skills 和 Extensions。",
      detail: projectPath,
      buttons: ["信任并打开", "只打开项目", "取消"],
      defaultId: 0,
      cancelId: 2,
    });
    if (trust.response === 2) return undefined;

    return projectStore.add(projectPath, trust.response === 0 ? "trusted" : "untrusted");
  });

  ipcMain.handle(IPC.projectsRemove, async (_event, projectId: string) => {
    agentManager.removeProject(projectId);
    await projectStore.remove(projectId);
  });

  ipcMain.handle(IPC.projectsSetPinned, (_event, projectId: string, pinned: boolean) =>
    projectStore.setPinned(projectId, pinned));

  ipcMain.handle(IPC.projectsReveal, async (_event, projectId: string) => {
    const project = await projectStore.get(projectId);
    shell.showItemInFolder(project.path);
  });

  ipcMain.handle(IPC.projectsActivate, async (_event, projectId: string, requestId: number) => {
    agentManager.requestActivation(projectId, requestId);
    const project = await projectStore.touch(projectId);
    return agentManager.activate(project, requestId);
  });

  ipcMain.handle(IPC.projectsStartNew, async (_event, projectId: string, requestId: number) => {
    agentManager.requestActivation(projectId, requestId);
    const project = await projectStore.touch(projectId);
    return agentManager.startNewSession(project, requestId);
  });

  ipcMain.handle(IPC.projectsSessions, async (_event, projectId: string) => {
    const project = await projectStore.get(projectId);
    return listProjectSessions(project.path);
  });

  ipcMain.handle(
    IPC.projectsSwitchSession,
    async (_event, projectId: string, sessionPath: string, requestId: number) => {
      agentManager.requestActivation(projectId, requestId);
      const project = await projectStore.touch(projectId);
      return agentManager.openSession(project, sessionPath, requestId);
    },
  );

  ipcMain.handle(
    IPC.projectsDeleteSession,
    async (_event, projectId: string, sessionPath: string) => {
      const project = await projectStore.get(projectId);
      agentManager.removeSession(projectId, sessionPath);
      await deleteProjectSession(project.path, sessionPath);
      await sessionViewCache.delete(sessionPath);
    },
  );

  ipcMain.handle(IPC.projectsSearchFiles, async (_event, projectId: string, query: string) => {
    const project = await projectStore.get(projectId);
    return fileSearchService.search(project.path, query);
  });

  ipcMain.handle(IPC.agentPrompt, async (_event, input: PromptInput) => {
    await agentManager.get(input.projectId).prompt(input.message, input.images, input.streamingBehavior);
  });

  ipcMain.handle(IPC.agentAbort, async (_event, projectId: string) => {
    await agentManager.get(projectId).abort();
  });

  ipcMain.handle(
    IPC.agentBuiltin,
    (_event, projectId: string, command: string, args: string) =>
      agentManager.get(projectId).runBuiltin(command, args),
  );

  ipcMain.handle(IPC.agentModels, (_event, projectId: string) =>
    agentManager.get(projectId).getModels(),
  );

  ipcMain.handle(
    IPC.agentSetModel,
    (_event, projectId: string, provider: string, modelId: string) =>
      agentManager.get(projectId).setModel(provider, modelId),
  );

  ipcMain.handle(IPC.agentThinkingLevels, (_event, projectId: string) =>
    agentManager.get(projectId).getThinkingLevels(),
  );

  ipcMain.handle(
    IPC.agentSetThinkingLevel,
    (_event, projectId: string, level: ThinkingLevel) =>
      agentManager.get(projectId).setThinkingLevel(level),
  );

  ipcMain.handle(IPC.agentTree, (_event, projectId: string) =>
    agentManager.get(projectId).getTree(),
  );

  ipcMain.handle(IPC.agentSessionStats, (_event, runtimeId: string) =>
    agentManager.getRuntime(runtimeId).getSessionStats(),
  );

  ipcMain.handle(
    IPC.agentShell,
    async (_event, projectId: string, command: string, includeInContext: boolean): Promise<ShellResult> => {
      if (includeInContext) {
        const result = await agentManager.get(projectId).runBash(command);
        return {
          output: String(result.output ?? ""),
          exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
          cancelled: Boolean(result.cancelled),
          truncated: Boolean(result.truncated),
        };
      }

      const project = await projectStore.get(projectId);
      return runLocalShell(project.path, command);
    },
  );

  ipcMain.handle(
    IPC.agentExtensionUiResponse,
    (_event, runtimeId: string, response: ExtensionUiResponse) => {
      agentManager.getRuntime(runtimeId).respondExtensionUi(response);
    },
  );

  ipcMain.handle(IPC.sessionViewGet, (_event, sessionPath: string) =>
    sessionViewCache.get(sessionPath));

  ipcMain.handle(IPC.sessionViewSet, (_event, sessionPath: string, value: unknown) =>
    sessionViewCache.set(sessionPath, value));

  ipcMain.handle(IPC.notificationTaskComplete, (_event, payload: TaskCompleteNotification) => {
    const notification = new Notification({
      title: "Pi Desktop",
      body: `${payload.projectName} 的回复已完成`,
      silent: true,
    });
    activeNotifications.add(notification);
    const release = () => activeNotifications.delete(notification);
    notification.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(IPC.notificationOpenSession, payload);
    });
    notification.on("close", release);
    notification.on("failed", release);
    notification.show();
    shell.beep();
  });

  ipcMain.handle(IPC.settingsGet, () => settingsStore.status());
  ipcMain.handle(IPC.settingsUpdate, async (_event, settings: AppSettings) => {
    await settingsStore.update(settings);
    return settingsStore.status();
  });
}

app.whenReady().then(() => {
  const userDataPath = app.getPath("userData");
  projectStore = new ProjectStore(userDataPath);
  settingsStore = new SettingsStore(userDataPath);
  sessionViewCache = new SessionViewCache(userDataPath);
  agentManager = new AgentManager(() => mainWindow, settingsStore);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => agentManager?.dispose());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
