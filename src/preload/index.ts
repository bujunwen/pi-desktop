import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentEventEnvelope,
  AppSettings,
  DesktopApi,
  ExtensionUiResponse,
  PromptInput,
  TaskCompleteNotification,
  ThinkingLevel,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

const api: DesktopApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    add: () => ipcRenderer.invoke(IPC.projectsAdd),
    remove: (projectId) => ipcRenderer.invoke(IPC.projectsRemove, projectId),
    setPinned: (projectId, pinned) => ipcRenderer.invoke(IPC.projectsSetPinned, projectId, pinned),
    reveal: (projectId) => ipcRenderer.invoke(IPC.projectsReveal, projectId),
    activate: (projectId, requestId) => ipcRenderer.invoke(IPC.projectsActivate, projectId, requestId),
    listSessions: (projectId) => ipcRenderer.invoke(IPC.projectsSessions, projectId),
    switchSession: (projectId, sessionPath, requestId) =>
      ipcRenderer.invoke(IPC.projectsSwitchSession, projectId, sessionPath, requestId),
    deleteSession: (projectId, sessionPath) =>
      ipcRenderer.invoke(IPC.projectsDeleteSession, projectId, sessionPath),
    searchFiles: (projectId, query) =>
      ipcRenderer.invoke(IPC.projectsSearchFiles, projectId, query),
  },
  agent: {
    prompt: (input: PromptInput) => ipcRenderer.invoke(IPC.agentPrompt, input),
    abort: (projectId) => ipcRenderer.invoke(IPC.agentAbort, projectId),
    runBuiltin: (projectId, command, args) =>
      ipcRenderer.invoke(IPC.agentBuiltin, projectId, command, args),
    getModels: (projectId) => ipcRenderer.invoke(IPC.agentModels, projectId),
    setModel: (projectId, provider, modelId) =>
      ipcRenderer.invoke(IPC.agentSetModel, projectId, provider, modelId),
    getThinkingLevels: (projectId) => ipcRenderer.invoke(IPC.agentThinkingLevels, projectId),
    setThinkingLevel: (projectId, level: ThinkingLevel) =>
      ipcRenderer.invoke(IPC.agentSetThinkingLevel, projectId, level),
    getTree: (projectId) => ipcRenderer.invoke(IPC.agentTree, projectId),
    runShell: (projectId, command, includeInContext) =>
      ipcRenderer.invoke(IPC.agentShell, projectId, command, includeInContext),
    respondExtensionUi: (runtimeId: string, response: ExtensionUiResponse) =>
      ipcRenderer.invoke(IPC.agentExtensionUiResponse, runtimeId, response),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, envelope: AgentEventEnvelope) => {
        listener(envelope);
      };
      ipcRenderer.on(IPC.agentEvent, handler);
      return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
    },
  },
  notifications: {
    taskComplete: (notification) => ipcRenderer.invoke(IPC.notificationTaskComplete, notification),
    onOpenSession: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, notification: TaskCompleteNotification) => {
        listener(notification);
      };
      ipcRenderer.on(IPC.notificationOpenSession, handler);
      return () => ipcRenderer.removeListener(IPC.notificationOpenSession, handler);
    },
  },
  sessionViews: {
    get: (sessionPath) => ipcRenderer.invoke(IPC.sessionViewGet, sessionPath),
    set: (sessionPath, value) => ipcRenderer.invoke(IPC.sessionViewSet, sessionPath, value),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsUpdate, settings),
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);
