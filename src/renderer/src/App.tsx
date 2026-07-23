import {
  ArrowUp,
  Check,
  ChevronDown,
  Ellipsis,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  LoaderCircle,
  MessageSquarePlus,
  Pin,
  PinOff,
  Settings,
  Square,
  Star,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSource,
  AppSettings,
  ExtensionUiResponse,
  FileMatch,
  ImageContent,
  PiCommandInfo,
  ProjectRecord,
  SessionSummary,
  ThinkingLevel,
} from "../../shared/contracts";
import { ActivationRequests } from "./activation-requests";
import { pinConversationToBottom, shouldFollowOutput } from "./scroll";
import {
  consecutiveToolGroups,
  type ConversationItem,
  type ExtensionDialogRequest,
  type ExtensionWidget,
  type ProjectConversation,
  type ToolItem,
  useAppStore,
} from "./store";

const EMPTY_WIDGETS: Record<string, ExtensionWidget> = {};
const EMPTY_SESSIONS: SessionSummary[] = [];
const EXPANDED_PROJECTS_KEY = "pi-desktop:expanded-projects";
const SESSION_LISTS_CACHE_KEY = "pi-desktop:session-lists";
const activationRequests = new ActivationRequests();

function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children: codeChildren }) {
          const match = /language-([\w-]+)/.exec(className ?? "");
          const code = String(codeChildren).replace(/\n$/, "");
          if (!match) return <code className="inline-code">{codeChildren}</code>;
          return (
            <Highlight theme={themes.vsDark} code={code} language={match[1] as Language}>
              {({ className: prismClass, style, tokens, getLineProps, getTokenProps }) => (
                <pre className={`${prismClass} code-block`} style={style}>
                  {tokens.map((line, lineIndex) => (
                    <div key={lineIndex} {...getLineProps({ line })}>
                      {line.map((token, tokenIndex) => (
                        <span key={tokenIndex} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

async function refreshSessions(projectId: string): Promise<void> {
  const sessions = await window.piDesktop.projects.listSessions(projectId);
  useAppStore.getState().setSessions(projectId, sessions);
}

async function reapplyProjectActivation(projectId: string, requestId: number): Promise<boolean> {
  const activation = await window.piDesktop.projects.activate(projectId, requestId);
  if (!activationRequests.isCurrent(requestId)) return false;
  useAppStore.getState().applyActivation(activation);
  return true;
}

async function activateProject(projectId: string): Promise<void> {
  const requestId = activationRequests.begin();
  const store = useAppStore.getState();
  store.beginActivation(projectId);
  try {
    const activation = await window.piDesktop.projects.activate(projectId, requestId);
    if (!activationRequests.isCurrent(requestId)) return;
    store.applyActivation(activation);
    await refreshSessions(projectId);
  } catch (error) {
    if (activationRequests.isCurrent(requestId)) {
      store.failActivation(projectId, (error as Error).message);
    }
  }
}

async function switchSession(projectId: string, sessionPath: string): Promise<void> {
  const requestId = activationRequests.begin();
  const store = useAppStore.getState();
  store.beginActivation(projectId);
  try {
    const activationPromise = window.piDesktop.projects.switchSession(projectId, sessionPath, requestId);
    void activationPromise.catch(() => undefined);
    const cached = await window.piDesktop.sessionViews.get(sessionPath);
    if (!activationRequests.isCurrent(requestId)) return;
    if (cached) store.showCachedSession(projectId, sessionPath, cached as ProjectConversation);
    const activation = await activationPromise;
    if (!activationRequests.isCurrent(requestId)) return;
    store.applyActivation(activation);
    const conversation = useAppStore.getState().conversations[projectId];
    void window.piDesktop.sessionViews.set(sessionPath, conversation);
    await refreshSessions(projectId);
  } catch (error) {
    if (activationRequests.isCurrent(requestId)) {
      store.failActivation(projectId, (error as Error).message);
    }
  }
}

async function beginNewTask(projectId: string): Promise<void> {
  const requestId = activationRequests.begin();
  const store = useAppStore.getState();
  store.beginActivation(projectId);
  try {
    await window.piDesktop.projects.activate(projectId, requestId);
    if (!activationRequests.isCurrent(requestId)) return;
    await window.piDesktop.agent.runBuiltin(projectId, "new", "");
    if (!activationRequests.isCurrent(requestId)) return;
    const activation = await window.piDesktop.projects.activate(projectId, requestId);
    if (!activationRequests.isCurrent(requestId)) return;
    store.applyActivation(activation);
    await refreshSessions(projectId);
  } catch (error) {
    if (activationRequests.isCurrent(requestId)) {
      store.failActivation(projectId, (error as Error).message);
    }
  }
}

function mostRecentlyUsedProject(projects: ProjectRecord[]): ProjectRecord | undefined {
  return projects.reduce<ProjectRecord | undefined>((latest, project) =>
    !latest || project.lastOpenedAt > latest.lastOpenedAt ? project : latest, undefined);
}

function sessionTitle(session: SessionSummary): string {
  return session.name || session.firstMessage || "新会话";
}

function deletionSessionTitle(session: SessionSummary): string {
  const characters = Array.from(sessionTitle(session).replace(/\s+/g, " ").trim());
  return characters.length > 10 ? `${characters.slice(0, 10).join("")}…` : characters.join("");
}

function Sidebar() {
  const projects = useAppStore((state) => state.projects);
  const sessions = useAppStore((state) => state.sessions);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const conversations = useAppStore((state) => state.conversations);
  const runtimeRunning = useAppStore((state) => state.runtimeRunning);
  const runtimeCompleted = useAppStore((state) => state.runtimeCompleted);
  const runtimeSessions = useAppStore((state) => state.runtimeSessions);
  const loadingProject = useAppStore((state) => state.loadingProject);
  const setProjects = useAppStore((state) => state.setProjects);
  const addProjectToStore = useAppStore((state) => state.addProject);
  const removeProjectFromStore = useAppStore((state) => state.removeProject);
  const removeSessionFromStore = useAppStore((state) => state.removeSession);
  const markSessionRead = useAppStore((state) => state.markSessionRead);
  const openDialog = useAppStore((state) => state.openDialog);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => {
    const stored = localStorage.getItem(EXPANDED_PROJECTS_KEY);
    return new Set<string>(stored ? JSON.parse(stored) as string[] : []);
  });
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string>();

  useEffect(() => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedProjectIds]));
  }, [expandedProjectIds]);

  const activeConversation = activeProjectId ? conversations[activeProjectId] : undefined;
  useEffect(() => {
    if (!activeProjectId || !activeConversation?.sessionFile || activeConversation.items.length === 0) return;
    setExpandedProjectIds((current) => {
      if (current.has(activeProjectId)) return current;
      return new Set(current).add(activeProjectId);
    });
  }, [activeConversation?.items.length, activeConversation?.sessionFile, activeProjectId]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!(event.target as Element).closest(".project-menu-wrap")) setOpenProjectMenuId(undefined);
    };
    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, []);

  const newTask = async () => {
    let project = projects.find((item) => item.id === activeProjectId) ?? mostRecentlyUsedProject(projects);
    if (!project) {
      project = await window.piDesktop.projects.add();
      if (!project) return;
      addProjectToStore(project);
    }
    await beginNewTask(project.id);
  };

  const removeProject = async (projectId: string, name: string) => {
    if (!window.confirm(`从 Pi Desktop 中移除 ${name}？\n不会删除项目文件或 Pi Session。`)) return;
    setOpenProjectMenuId(undefined);
    await window.piDesktop.projects.remove(projectId);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    removeProjectFromStore(projectId);
  };

  const setProjectPinned = async (projectId: string, pinned: boolean) => {
    setOpenProjectMenuId(undefined);
    setProjects(await window.piDesktop.projects.setPinned(projectId, pinned));
  };

  const deleteSession = async (projectId: string, session: SessionSummary) => {
    if (!window.confirm(`永久删除会话“${deletionSessionTitle(session)}”？\n此操作不可恢复。`)) return;
    await window.piDesktop.projects.deleteSession(projectId, session.path);
    removeSessionFromStore(projectId, session.path);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-drag-region" />
      <div className="brand-row">
        <div className="brand">Pi Desktop</div>
      </div>

      <button className="sidebar-action" onClick={() => void newTask()}>
        <MessageSquarePlus size={16} />
        新建任务
      </button>

      <div className="sidebar-section-title">项目</div>
      <div className="project-list">
        {projects.map((project) => {
          const conversation = conversations[project.id];
          const projectSessions = sessions[project.id] ?? [];
          const selected = project.id === activeProjectId
            && !loadingProject
            && !conversation?.items.length;
          const expanded = expandedProjectIds.has(project.id);
          return (
            <div key={project.id} className="project-block">
              <div className={`project-row-wrap ${selected ? "selected" : ""}`}>
                <button className="project-row" onClick={() => {
                  setExpandedProjectIds((current) => {
                    const next = new Set(current);
                    if (next.has(project.id)) next.delete(project.id);
                    else next.add(project.id);
                    return next;
                  });
                }}>
                  <Folder size={15} />
                  <span className="project-name">{project.name}</span>
                  {project.pinned && <Star className="project-star" size={13} fill="currentColor" />}
                </button>
                <div className="project-menu-wrap">
                  <button
                    className="project-more"
                    title="项目操作"
                    onClick={() => setOpenProjectMenuId(openProjectMenuId === project.id ? undefined : project.id)}
                  >
                    <Ellipsis size={15} />
                  </button>
                  {openProjectMenuId === project.id && (
                    <div className="project-menu">
                      <button onClick={() => {
                        setOpenProjectMenuId(undefined);
                        void window.piDesktop.projects.reveal(project.id);
                      }}><FolderOpen size={14} /><span>在 Finder 中显示</span></button>
                      <button onClick={() => void setProjectPinned(project.id, !project.pinned)}>
                        {project.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                        <span>{project.pinned ? "取消置顶" : "置顶项目"}</span>
                      </button>
                      <button className="danger" onClick={() => void removeProject(project.id, project.name)}>
                        <Trash2 size={14} /><span>删除项目</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {expanded && (
                <div className="session-list">
                  {projectSessions.slice(0, 8).map((session) => {
                    const runtimeId = Object.keys(runtimeSessions).find((id) => runtimeSessions[id] === session.path);
                    const sessionRunning = Boolean(runtimeId && runtimeRunning[runtimeId])
                      || Boolean(project.id === activeProjectId
                        && conversation?.sessionFile === session.path
                        && conversation.running);
                    return (
                      <div className="session-row-wrap" key={session.path}>
                        <button
                          className={`session-row ${conversation?.sessionFile === session.path ? "active" : ""}`}
                          title={sessionTitle(session)}
                          onClick={() => {
                            markSessionRead(session.path);
                            void switchSession(project.id, session.path);
                          }}
                        >
                          <span>{sessionTitle(session)}</span>
                          {sessionRunning
                            ? <LoaderCircle className="session-spinner spin" size={13} />
                            : runtimeId && runtimeCompleted[runtimeId] && <span className="completed-dot" />}
                        </button>
                        <button
                          className="session-delete"
                          title="删除会话"
                          disabled={loadingProject && project.id === activeProjectId}
                          onClick={() => void deleteSession(project.id, session)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button className="sidebar-footer" onClick={() => openDialog("settings")}>
        <Settings size={15} />
        <span>设置</span>
      </button>
    </aside>
  );
}

function toolTarget(item: ToolItem): string {
  if (item.name === "bash" || item.name === "!" || item.name === "!!") {
    return String(item.args.command ?? "");
  }
  return String(
    item.args.path
      ?? item.args.filePath
      ?? item.args.query
      ?? item.args.pattern
      ?? "",
  );
}

function ToolActivityLine({ item }: { item: ToolItem }) {
  return (
    <div className={`tool-activity-line ${item.status}`}>
      {item.status === "running"
        ? <LoaderCircle className="spin" size={14} />
        : item.status === "error"
          ? <X size={14} />
          : <Check size={14} />}
      <strong>{item.name}</strong>
      <span>{toolTarget(item)}</span>
    </div>
  );
}

function ToolActivity({ items, running }: { items: ToolItem[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const latest = items[items.length - 1];

  if (running) {
    return (
      <section className="tool-activity running" aria-live="polite">
        <div className="tool-activity-wheel">
          {items.slice(-2).map((item) => <ToolActivityLine key={item.id} item={item} />)}
        </div>
      </section>
    );
  }

  return (
    <section className="tool-activity complete">
      <button className="tool-activity-summary" onClick={() => setExpanded((value) => !value)}>
        <TerminalSquare size={15} />
        <strong>已完成 {items.length} 项操作</strong>
        <span>{latest && toolTarget(latest)}</span>
        <ChevronDown className={expanded ? "rotated" : ""} size={14} />
      </button>
      {expanded && (
        <div className="tool-activity-history">
          {items.map((item) => <ToolActivityLine key={item.id} item={item} />)}
        </div>
      )}
    </section>
  );
}

function imageSource(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function imageFromFile(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      type: "image",
      data: String(reader.result).split(",", 2)[1],
      mimeType: file.type,
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ImageLightbox({ image, onClose }: { image: ImageContent; onClose(): void }) {
  return (
    <div className="image-lightbox" onMouseDown={onClose}>
      <button title="关闭预览" onClick={onClose}><X size={20} /></button>
      <img src={imageSource(image)} alt="图片预览" onMouseDown={(event) => event.stopPropagation()} />
    </div>
  );
}

function Conversation({ items, running }: { items: ConversationItem[]; running: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followFrameRef = useRef<number | undefined>(undefined);
  const followOutputRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const [previewImage, setPreviewImage] = useState<ImageContent>();
  const latestItem = items[items.length - 1];
  const latestPromptId = latestItem?.kind === "user" ? latestItem.id : undefined;
  const toolActivity = useMemo(() => {
    const byFirstToolId = new Map<string, ToolItem[]>();
    for (const tools of consecutiveToolGroups(items)) byFirstToolId.set(tools[0].id, tools);
    return byFirstToolId;
  }, [items]);

  const scheduleFollow = () => {
    if (!followOutputRef.current || followFrameRef.current !== undefined) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = undefined;
      const target = scrollRef.current;
      if (!followOutputRef.current || !target) return;
      pinConversationToBottom(target);
      previousScrollTopRef.current = target.scrollTop;
    });
  };

  const cancelScheduledFollow = () => {
    if (followFrameRef.current === undefined) return;
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = undefined;
  };

  useEffect(() => {
    if (!latestPromptId) return;
    followOutputRef.current = true;
    scheduleFollow();
  }, [latestPromptId]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const conversation = conversationRef.current;
    if (!scroll || !conversation) return;

    const observer = new ResizeObserver(scheduleFollow);
    observer.observe(scroll);
    observer.observe(conversation);
    return () => {
      observer.disconnect();
      cancelScheduledFollow();
    };
  }, []);

  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={() => {
        const target = scrollRef.current;
        if (!target) return;
        followOutputRef.current = shouldFollowOutput(
          followOutputRef.current,
          previousScrollTopRef.current,
          target,
        );
        previousScrollTopRef.current = target.scrollTop;
        if (!followOutputRef.current) cancelScheduledFollow();
      }}
    >
      <div className="conversation" ref={conversationRef}>
        {items.map((item) => {
          if (item.kind === "user") return (
            <div key={item.id} className="user-message">
              {item.images?.length && (
                <div className="message-images">
                  {item.images.map((image, index) => (
                    <button key={index} onClick={() => setPreviewImage(image)}>
                      <img src={imageSource(image)} alt={`附件 ${index + 1}`} />
                    </button>
                  ))}
                </div>
              )}
              {item.text && <div>{item.text}</div>}
            </div>
          );
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className={`assistant-message ${item.done ? "" : "streaming"}`}>
                {item.thinking && <details className="thinking"><summary>思考过程</summary>{item.thinking}</details>}
                <MarkdownContent>{item.text}</MarkdownContent>
                {!item.done && <span className="streaming-caret" />}
              </div>
            );
          }
          if (item.kind === "tool") {
            const group = toolActivity.get(item.id);
            if (!group) return null;
            return (
              <ToolActivity
                key={item.id}
                items={group}
                running={running && group[group.length - 1].id === latestItem?.id}
              />
            );
          }
          return <div key={item.id} className={`notice ${item.tone}`}>{item.text}</div>;
        })}
        {running && latestItem?.kind === "user" && (
          <div className="assistant-pending">
            <LoaderCircle className="spin" size={15} />
            <span>正在思考…</span>
          </div>
        )}
        <div className="conversation-end" />
      </div>
      {previewImage && <ImageLightbox image={previewImage} onClose={() => setPreviewImage(undefined)} />}
    </div>
  );
}

function CommandMenu({
  commands,
  selectedIndex,
  onChoose,
}: {
  commands: PiCommandInfo[];
  selectedIndex: number;
  onChoose(command: PiCommandInfo): void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="command-menu">
      {commands.map((command, index) => (
        <button
          key={`${command.source}:${command.name}`}
          className={index === selectedIndex ? "selected" : ""}
          onMouseDown={() => onChoose(command)}
        >
          <span>/{command.name}</span>
          <small>{command.description}</small>
          <em>{command.source}</em>
        </button>
      ))}
    </div>
  );
}

function FileMenu({
  matches,
  selectedIndex,
  onChoose,
}: {
  matches: FileMatch[];
  selectedIndex: number;
  onChoose(match: FileMatch): void;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="command-menu file-menu">
      {matches.map((match, index) => (
        <button
          key={match.path}
          className={index === selectedIndex ? "selected" : ""}
          onMouseDown={() => onChoose(match)}
        >
          <FileCode2 size={14} />
          <span>{match.path}</span>
        </button>
      ))}
    </div>
  );
}

function Composer() {
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const loadingProject = useAppStore((state) => state.loadingProject);
  const projects = useAppStore((state) => state.projects);
  const conversation = useAppStore((state) => state.activeProjectId ? state.conversations[state.activeProjectId] : undefined);
  const addUserMessage = useAppStore((state) => state.addUserMessage);
  const addPendingSession = useAppStore((state) => state.addPendingSession);
  const addShellResult = useAppStore((state) => state.addShellResult);
  const openDialog = useAppStore((state) => state.openDialog);
  const activeRuntimeId = useAppStore((state) => state.activeProjectId ? state.activeRuntimeIds[state.activeProjectId] : undefined);
  const extensionWidgets = useAppStore((state) => activeRuntimeId ? state.extensionWidgets[activeRuntimeId] ?? EMPTY_WIDGETS : EMPTY_WIDGETS);
  const editorRequest = useAppStore((state) => activeRuntimeId ? state.runtimeEditorRequests[activeRuntimeId] : undefined);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [openPicker, setOpenPicker] = useState<"project" | "model" | "thinking">();
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [attachments, setAttachments] = useState<ImageContent[]>([]);
  const [previewImage, setPreviewImage] = useState<ImageContent>();
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const slashMatch = text.match(/^\/([^\s]*)$/);
  const fileMatch = text.match(/(?:^|\s)@([^\s@]*)$/);
  const commandMatches = useMemo(() => {
    const query = (slashMatch?.[1] ?? "").toLowerCase();
    if (!slashMatch) return [];
    return (conversation?.commands ?? [])
      .filter((command) => `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [conversation?.commands, slashMatch?.[1]]);

  useEffect(() => { textareaRef.current?.focus(); }, [activeProjectId]);
  useEffect(() => {
    const composer = composerWrapRef.current;
    if (!composer) return;
    const updateClearance = () => {
      document.documentElement.style.setProperty("--composer-clearance", `${composer.offsetHeight + 44}px`);
    };
    updateClearance();
    const observer = new ResizeObserver(updateClearance);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const closePicker = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest(".project-picker-wrap, .composer-control-wrap")) setOpenPicker(undefined);
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, []);
  useEffect(() => {
    if (!editorRequest) return;
    setText(editorRequest.text);
    textareaRef.current?.focus();
  }, [editorRequest?.nonce]);
  useEffect(() => { setSelectedIndex(0); }, [slashMatch?.[1], fileMatch?.[1]]);
  useEffect(() => {
    if (!activeProjectId || !fileMatch) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.piDesktop.projects.searchFiles(activeProjectId, fileMatch[1]).then((matches) => {
        if (!cancelled) setFileMatches(matches);
      });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProjectId, fileMatch?.[1]]);

  const chooseCommand = (command: PiCommandInfo) => {
    setText(`/${command.name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseFile = (match: FileMatch) => {
    setText((current) => current.replace(/@[^\s@]*$/, `@${match.path} `));
    setFileMatches([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseProject = async (projectId: string) => {
    setOpenPicker(undefined);
    await beginNewTask(projectId);
  };

  const addProject = async () => {
    const project = await window.piDesktop.projects.add();
    if (!project) return;
    useAppStore.getState().addProject(project);
    await chooseProject(project.id);
  };

  const toggleModels = async () => {
    if (!activeProjectId) return;
    const opening = openPicker !== "model";
    setOpenPicker(opening ? "model" : undefined);
    if (opening) setModels(await window.piDesktop.agent.getModels(activeProjectId));
  };

  const chooseModel = async (model: Record<string, unknown>) => {
    if (!activeProjectId) return;
    const requestId = activationRequests.current();
    await window.piDesktop.agent.setModel(activeProjectId, String(model.provider), String(model.id));
    if (!activationRequests.isCurrent(requestId)) return;
    await reapplyProjectActivation(activeProjectId, requestId);
    setOpenPicker(undefined);
  };

  const toggleThinking = async () => {
    if (!activeProjectId) return;
    const opening = openPicker !== "thinking";
    setOpenPicker(opening ? "thinking" : undefined);
    if (opening) setThinkingLevels(await window.piDesktop.agent.getThinkingLevels(activeProjectId));
  };

  const chooseThinkingLevel = async (level: ThinkingLevel) => {
    if (!activeProjectId) return;
    const requestId = activationRequests.current();
    await window.piDesktop.agent.setThinkingLevel(activeProjectId, level);
    if (!activationRequests.isCurrent(requestId)) return;
    await reapplyProjectActivation(activeProjectId, requestId);
  };

  const send = async (followUp = false, suggestedText?: string) => {
    const message = (suggestedText ?? text).trim();
    const images = attachments;
    if (!activeProjectId || loadingProject || (!message && images.length === 0) || sending) return;

    setText("");
    setAttachments([]);
    setSending(true);
    try {
      if (images.length === 0 && message.startsWith("!")) {
        const included = !message.startsWith("!!");
        const command = message.slice(included ? 1 : 2).trim();
        if (!command) throw new Error("请输入要运行的命令");
        addShellResult(
          activeProjectId,
          command,
          await window.piDesktop.agent.runShell(activeProjectId, command, included),
          included,
        );
        return;
      }

      const commandMatch = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      const builtin = images.length === 0 && commandMatch
        ? conversation?.commands.find((candidate) => candidate.name === commandMatch[1] && candidate.source === "builtin")
        : undefined;

      if (builtin && ["model", "thinking", "tree", "resume", "settings"].includes(builtin.name)) {
        const dialog = builtin.name === "resume" ? "sessions" : builtin.name;
        openDialog(dialog as "model" | "thinking" | "tree" | "sessions" | "settings");
        return;
      }

      if (builtin) {
        const requestId = activationRequests.current();
        await window.piDesktop.agent.runBuiltin(activeProjectId, builtin.name, commandMatch?.[2] ?? "");
        if (!activationRequests.isCurrent(requestId)) return;
        await reapplyProjectActivation(activeProjectId, requestId);
        await refreshSessions(activeProjectId);
        return;
      }

      addPendingSession(activeProjectId, conversation!.sessionFile!, message || "图片");
      addUserMessage(activeProjectId, message, images);
      await window.piDesktop.agent.prompt({
        projectId: activeProjectId,
        message,
        ...(images.length ? { images } : {}),
        ...(conversation?.running
          ? { streamingBehavior: followUp ? ("followUp" as const) : ("steer" as const) }
          : {}),
      });
    } catch (error) {
      useAppStore.getState().failActivation(activeProjectId, (error as Error).message);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const activeMenu = slashMatch ? commandMatches : fileMatch ? fileMatches : [];
  const aboveWidgets = Object.entries(extensionWidgets).filter(([, widget]) => widget.placement === "aboveEditor");
  const belowWidgets = Object.entries(extensionWidgets).filter(([, widget]) => widget.placement === "belowEditor");

  return (
    <div className="composer-wrap" ref={composerWrapRef}>
      {aboveWidgets.map(([key, widget]) => <pre className="extension-widget" key={key}>{widget.lines.join("\n")}</pre>)}
      {conversation && (conversation.steering.length > 0 || conversation.followUp.length > 0) && (
        <div className="queue-pills">
          {conversation.steering.map((message) => <span key={`s-${message}`}>转向：{message}</span>)}
          {conversation.followUp.map((message) => <span key={`f-${message}`}>后续：{message}</span>)}
        </div>
      )}
      {slashMatch && <CommandMenu commands={commandMatches} selectedIndex={selectedIndex} onChoose={chooseCommand} />}
      {!slashMatch && fileMatch && <FileMenu matches={fileMatches} selectedIndex={selectedIndex} onChoose={chooseFile} />}
      {activeProject && !conversation?.items.length && (
        <div className="project-picker-wrap">
          <button className="project-picker-button" onClick={() => setOpenPicker(openPicker === "project" ? undefined : "project")}>
            <Folder size={14} />
            <span>{activeProject.name}</span>
            <ChevronDown size={13} />
          </button>
          {openPicker === "project" && (
            <div className="project-popover">
              <div className="popover-title">选择项目</div>
              {projects.map((project) => (
                <button key={project.id} className={project.id === activeProjectId ? "selected" : ""} onClick={() => void chooseProject(project.id)}>
                  <Folder size={14} />
                  <span>{project.name}</span>
                  {project.id === activeProjectId && <Check size={14} />}
                </button>
              ))}
              <button className="add-project-option" onClick={() => void addProject()}>
                <FolderPlus size={14} />
                <span>添加新项目</span>
              </button>
            </div>
          )}
        </div>
      )}
      <div className="composer">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((image, index) => (
              <div className="composer-attachment" key={`${image.mimeType}-${index}`}>
                <button className="attachment-preview" onClick={() => setPreviewImage(image)}>
                  <img src={imageSource(image)} alt={`待发送图片 ${index + 1}`} />
                </button>
                <button
                  className="attachment-remove"
                  title="移除图片"
                  onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          disabled={!activeProjectId || loadingProject}
          placeholder={loadingProject ? "正在恢复会话…" : activeProjectId ? "随心输入，/ 命令，@ 文件，! 运行命令" : "请先添加或选择项目"}
          rows={3}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile()!);
            if (files.length === 0) return;
            event.preventDefault();
            void Promise.all(files.map(imageFromFile)).then((images) => {
              setAttachments((current) => [...current, ...images]);
            });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && conversation?.running && activeProjectId) {
              event.preventDefault();
              void window.piDesktop.agent.abort(activeProjectId);
              return;
            }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && activeMenu.length > 0) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setSelectedIndex((index) => (index + direction + activeMenu.length) % activeMenu.length);
              return;
            }
            if (event.key === "Enter" && slashMatch) {
              const exact = commandMatches.find((command) => command.name === slashMatch[1]);
              if (exact) {
                event.preventDefault();
                void send(event.altKey);
                return;
              }
            }
            if ((event.key === "Tab" || event.key === "Enter") && slashMatch && commandMatches.length > 0) {
              event.preventDefault();
              chooseCommand(commandMatches[selectedIndex] ?? commandMatches[0]);
              return;
            }
            if ((event.key === "Tab" || event.key === "Enter") && fileMatch && fileMatches.length > 0) {
              event.preventDefault();
              chooseFile(fileMatches[selectedIndex] ?? fileMatches[0]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(event.altKey);
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-actions">
            {conversation?.model && (
              <div className="composer-control-wrap">
                <button className="composer-select" onClick={() => void toggleModels()}>{conversation.model}</button>
                {openPicker === "model" && (
                  <div className="composer-popover model-popover">
                    <div className="popover-title">模型</div>
                    {models.map((model) => {
                      const id = String(model.id);
                      return (
                        <button key={`${model.provider}/${id}`} className={id === conversation.model ? "selected" : ""} onClick={() => void chooseModel(model)}>
                          <span><strong>{String(model.name ?? id)}</strong><small>{String(model.provider)}</small></span>
                          {id === conversation.model && <Check size={14} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {conversation?.thinkingLevel && (
              <div className="composer-control-wrap">
                <button className="composer-select" onClick={() => void toggleThinking()}>{conversation.thinkingLevel}</button>
                {openPicker === "thinking" && thinkingLevels.length > 0 && (
                  <div className="composer-popover thinking-popover">
                    <div className="thinking-popover-title">强度 <strong>{conversation.thinkingLevel}</strong></div>
                    <div className="thinking-range-labels"><span>更快</span><span>更聪明</span></div>
                    <input
                      aria-label="模型强度"
                      type="range"
                      min={0}
                      max={thinkingLevels.length - 1}
                      step={1}
                      value={Math.max(0, thinkingLevels.indexOf(conversation.thinkingLevel))}
                      onChange={(event) => void chooseThinkingLevel(thinkingLevels[Number(event.target.value)])}
                    />
                    <div className="thinking-range-steps">
                      {thinkingLevels.map((level) => <span key={level} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              className={`send-button ${conversation?.running ? "running" : ""}`}
              onClick={() => conversation?.running && activeProjectId
                ? void window.piDesktop.agent.abort(activeProjectId)
                : void send(false)}
              disabled={loadingProject || !conversation?.running && (!text.trim() && attachments.length === 0 || sending)}
              title={conversation?.running ? "停止" : "发送"}
            >
              {conversation?.running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={19} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
      {belowWidgets.map(([key, widget]) => <pre className="extension-widget below" key={key}>{widget.lines.join("\n")}</pre>)}
      {previewImage && <ImageLightbox image={previewImage} onClose={() => setPreviewImage(undefined)} />}
    </div>
  );
}

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  const closeDialog = useAppStore((state) => state.closeDialog);
  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button onClick={closeDialog}><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}

function ModelDialog() {
  const projectId = useAppStore((state) => state.activeProjectId)!;
  const currentModel = useAppStore((state) => state.conversations[projectId]?.model);
  const closeDialog = useAppStore((state) => state.closeDialog);
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => { void window.piDesktop.agent.getModels(projectId).then(setModels); }, [projectId]);
  const filtered = models.filter((model) =>
    `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Modal title="选择模型">
      <input className="modal-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" />
      <div className="modal-list">
        {filtered.map((model) => {
          const id = String(model.id);
          const provider = String(model.provider);
          return (
            <button key={`${provider}/${id}`} onClick={async () => {
              const requestId = activationRequests.current();
              await window.piDesktop.agent.setModel(projectId, provider, id);
              if (!activationRequests.isCurrent(requestId)) return;
              await reapplyProjectActivation(projectId, requestId);
              closeDialog();
            }}>
              <span><strong>{String(model.name ?? id)}</strong><small>{provider}/{id}</small></span>
              {id === currentModel && <Check size={16} />}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function ThinkingDialog() {
  const projectId = useAppStore((state) => state.activeProjectId)!;
  const currentLevel = useAppStore((state) => state.conversations[projectId]?.thinkingLevel);
  const closeDialog = useAppStore((state) => state.closeDialog);
  const [levels, setLevels] = useState<ThinkingLevel[]>([]);
  useEffect(() => { void window.piDesktop.agent.getThinkingLevels(projectId).then(setLevels); }, [projectId]);

  return (
    <Modal title="思考级别">
      <div className="modal-list thinking-levels">
        {levels.map((level) => (
          <button key={level} onClick={async () => {
            const requestId = activationRequests.current();
            await window.piDesktop.agent.setThinkingLevel(projectId, level);
            if (!activationRequests.isCurrent(requestId)) return;
            await reapplyProjectActivation(projectId, requestId);
            closeDialog();
          }}>
            <span><strong>{level}</strong><small>{level === "off" ? "关闭模型推理" : "提高推理深度会增加响应时间和 Token 消耗"}</small></span>
            {level === currentLevel && <Check size={16} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}

type TreeNode = { entry: Record<string, unknown>; children: TreeNode[]; label?: string };

function entryLabel(entry: Record<string, unknown>): string {
  if (entry.type !== "message") return String(entry.type ?? "entry");
  const message = (entry.message ?? {}) as Record<string, unknown>;
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block as Record<string, unknown>).text ?? "").join("")
      : "";
  return `${message.role ?? "message"}: ${String(text).slice(0, 100)}`;
}

function TreeBranch({ nodes, depth = 0, onFork }: { nodes: TreeNode[]; depth?: number; onFork(id: string): void }) {
  return <>{nodes.map((node) => {
    const entry = node.entry;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    return (
      <div key={String(entry.id)}>
        <div className="tree-entry" style={{ paddingLeft: 14 + depth * 18 }}>
          <span>{node.label || entryLabel(entry)}</span>
          {entry.type === "message" && message.role === "user" && (
            <button title="从这里分叉" onClick={() => onFork(String(entry.id))}><GitFork size={14} /></button>
          )}
        </div>
        <TreeBranch nodes={node.children ?? []} depth={depth + 1} onFork={onFork} />
      </div>
    );
  })}</>;
}

function TreeDialog() {
  const projectId = useAppStore((state) => state.activeProjectId)!;
  const [tree, setTree] = useState<TreeNode[]>([]);
  useEffect(() => {
    void window.piDesktop.agent.getTree(projectId).then((data) => setTree((data.tree ?? []) as TreeNode[]));
  }, [projectId]);

  return (
    <Modal title="会话树">
      <div className="tree-list">
        <TreeBranch nodes={tree} onFork={async (entryId) => {
          const requestId = activationRequests.current();
          await window.piDesktop.agent.runBuiltin(projectId, "fork", entryId);
          if (!activationRequests.isCurrent(requestId)) return;
          await reapplyProjectActivation(projectId, requestId);
          await refreshSessions(projectId);
        }} />
      </div>
    </Modal>
  );
}

function SessionsDialog() {
  const projectId = useAppStore((state) => state.activeProjectId)!;
  const sessions = useAppStore((state) => state.sessions[projectId] ?? EMPTY_SESSIONS);
  const [query, setQuery] = useState("");
  const filtered = sessions.filter((session) =>
    `${session.name ?? ""} ${session.firstMessage}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="历史会话">
      <input className="modal-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" />
      <div className="modal-list">
        {filtered.map((session) => (
          <button key={session.path} onClick={() => void switchSession(projectId, session.path)}>
            <span><strong>{sessionTitle(session)}</strong><small>{session.messageCount} 条消息 · {new Date(session.modifiedAt).toLocaleString()}</small></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SettingsDialog() {
  const status = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const closeDialog = useAppStore((state) => state.closeDialog);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const [source, setSource] = useState<AgentSource>(status?.agentSource ?? "system");
  const [customPath, setCustomPath] = useState(status?.customPiPath ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <Modal title="设置">
      <div className="settings-body">
        <h3>Pi Agent 来源</h3>
        {(["system", "bundled", "custom"] as AgentSource[]).map((item) => (
          <label className={`settings-option ${source === item ? "selected" : ""}`} key={item}>
            <input type="radio" name="agent-source" checked={source === item} onChange={() => setSource(item)} />
            <span>
              <strong>{item === "system" ? "System Pi" : item === "bundled" ? "Bundled Pi" : "自定义路径"}</strong>
              <small>{item === "system" ? "使用系统安装的 Pi" : item === "bundled" ? `随应用提供的 Pi ${status?.bundledVersion ?? ""}` : "使用指定的 Pi 可执行文件"}</small>
            </span>
          </label>
        ))}
        {source === "custom" && (
          <input className="modal-search settings-path" value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="/absolute/path/to/pi" />
        )}
        {status && <p className="settings-current">当前：{status.version} · {status.resolvedPath}</p>}
        {error && <p className="settings-error">{error}</p>}
        <div className="modal-actions">
          <button onClick={closeDialog}>取消</button>
          <button className="primary" disabled={saving} onClick={async () => {
            setSaving(true);
            setError("");
            try {
              const next: AppSettings = {
                agentSource: source,
                ...(source === "custom" ? { customPiPath: customPath.trim() } : {}),
              };
              setSettings(await window.piDesktop.settings.update(next));
              if (activeProjectId) await activateProject(activeProjectId);
              else closeDialog();
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setSaving(false);
            }
          }}>保存并重启 Agent</button>
        </div>
      </div>
    </Modal>
  );
}

function ActiveDialog() {
  const dialog = useAppStore((state) => state.activeDialog);
  if (dialog === "model") return <ModelDialog />;
  if (dialog === "thinking") return <ThinkingDialog />;
  if (dialog === "tree") return <TreeDialog />;
  if (dialog === "sessions") return <SessionsDialog />;
  if (dialog === "settings") return <SettingsDialog />;
  return null;
}

function ExtensionPrompt({ item }: { item: ExtensionDialogRequest }) {
  const dismiss = useAppStore((state) => state.dismissExtensionDialog);
  const request = item.request;
  const [value, setValue] = useState(String(request.prefill ?? ""));
  const respond = async (response: ExtensionUiResponse) => {
    try {
      await window.piDesktop.agent.respondExtensionUi(item.runtimeId, response);
    } catch (error) {
      useAppStore.getState().failActivation(item.projectId, (error as Error).message);
    } finally {
      dismiss(request.id);
    }
  };
  const cancel = () => void respond({ type: "extension_ui_response", id: request.id, cancelled: true });

  return (
    <div className="modal-backdrop extension-modal">
      <section className="modal">
        <header><h2>{String(request.title ?? "Extension 请求")}</h2><button onClick={cancel}><X size={18} /></button></header>
        {request.method === "select" && (
          <div className="modal-list extension-options">
            {((request.options ?? []) as unknown[]).map((option) => (
              <button key={String(option)} onClick={() => void respond({ type: "extension_ui_response", id: request.id, value: String(option) })}>
                <span><strong>{String(option)}</strong></span>
              </button>
            ))}
          </div>
        )}
        {request.method === "confirm" && <p className="extension-message">{String(request.message ?? "")}</p>}
        {(request.method === "input" || request.method === "editor") && (
          request.method === "editor"
            ? <textarea className="extension-editor" autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
            : <input className="modal-search" autoFocus value={value} placeholder={String(request.placeholder ?? "")} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter") void respond({ type: "extension_ui_response", id: request.id, value });
              }} />
        )}
        {request.method !== "select" && (
          <div className="modal-actions extension-actions">
            <button onClick={cancel}>取消</button>
            <button className="primary" onClick={() => void respond(request.method === "confirm"
              ? { type: "extension_ui_response", id: request.id, confirmed: true }
              : { type: "extension_ui_response", id: request.id, value })}>
              {request.method === "confirm" ? "确认" : "提交"}
            </button>
            {request.method === "confirm" && (
              <button onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: false })}>否</button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ExtensionUiLayer() {
  const item = useAppStore((state) => state.extensionDialogs[0]);
  return item ? <ExtensionPrompt key={item.request.id} item={item} /> : null;
}

function EmptyState() {
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const projects = useAppStore((state) => state.projects);
  const project = projects.find((item) => item.id === activeProjectId);

  return (
    <div className="empty-state">
      <h1>{project ? `在 ${project.name} 构建什么？` : "点击新建任务开始工作"}</h1>
    </div>
  );
}

export function App() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setSessions = useAppStore((state) => state.setSessions);
  const setSettings = useAppStore((state) => state.setSettings);
  const handleAgentEvent = useAppStore((state) => state.handleAgentEvent);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const conversation = useAppStore((state) => state.activeProjectId ? state.conversations[state.activeProjectId] : undefined);
  const loadingProject = useAppStore((state) => state.loadingProject);
  const activeRuntimeId = useAppStore((state) => state.activeProjectId ? state.activeRuntimeIds[state.activeProjectId] : undefined);
  const extensionTitle = useAppStore((state) => activeRuntimeId ? state.extensionTitles[activeRuntimeId] : undefined);
  const sessionLists = useAppStore((state) => state.sessions);
  const didStartInitialTask = useRef(false);
  const didInitializeSessionLists = useRef(false);
  const didSkipInitialSessionListsWrite = useRef(false);

  useEffect(() => {
    document.title = extensionTitle || "Pi Desktop";
  }, [extensionTitle]);

  useEffect(() => {
    const cachedSessionLists = JSON.parse(
      localStorage.getItem(SESSION_LISTS_CACHE_KEY) ?? "{}",
    ) as Record<string, SessionSummary[]>;
    for (const [projectId, projectSessions] of Object.entries(cachedSessionLists)) {
      setSessions(projectId, projectSessions);
    }
    didInitializeSessionLists.current = true;

    void window.piDesktop.settings.get().then(setSettings);
    void window.piDesktop.projects.list().then(async (projects) => {
      setProjects(projects);
      const initialProject = didStartInitialTask.current ? undefined : mostRecentlyUsedProject(projects);
      if (initialProject) {
        didStartInitialTask.current = true;
        void beginNewTask(initialProject.id);
      }
      await Promise.all(projects
        .filter((project) => !(project.id in cachedSessionLists))
        .map(async (project) => {
          try {
            setSessions(project.id, await window.piDesktop.projects.listSessions(project.id));
          } catch {
            setSessions(project.id, []);
          }
        }));
    });
    const removeAgentListener = window.piDesktop.agent.onEvent((envelope) => {
      handleAgentEvent(envelope);
      if (envelope.event.type === "agent_settled") {
        void refreshSessions(envelope.projectId);
        const state = useAppStore.getState();
        const projectName = state.projects
          .find((project) => project.id === envelope.projectId)!.name;
        const sessionPath = state.runtimeSessions[envelope.runtimeId];
        if (state.activeRuntimeIds[envelope.projectId] === envelope.runtimeId) {
          void window.piDesktop.sessionViews.set(
            sessionPath,
            state.conversations[envelope.projectId],
          );
        }
        void window.piDesktop.notifications.taskComplete({
          projectId: envelope.projectId,
          projectName,
          sessionPath,
        });
      }
    });
    const removeNotificationListener = window.piDesktop.notifications.onOpenSession((notification) => {
      useAppStore.getState().markSessionRead(notification.sessionPath);
      void switchSession(notification.projectId, notification.sessionPath);
    });
    return () => {
      removeAgentListener();
      removeNotificationListener();
    };
  }, [handleAgentEvent, setProjects, setSessions, setSettings]);

  useEffect(() => {
    if (!didInitializeSessionLists.current) return;
    if (!didSkipInitialSessionListsWrite.current) {
      didSkipInitialSessionListsWrite.current = true;
      return;
    }
    localStorage.setItem(SESSION_LISTS_CACHE_KEY, JSON.stringify(sessionLists));
  }, [sessionLists]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        <div className="window-drag-region" />
        {activeProjectId && conversation?.items.length ? (
          <>
            <Conversation items={conversation.items} running={conversation.running} />
            {loadingProject && (
              <div className="session-connecting"><LoaderCircle className="spin" size={14} />正在后台恢复会话…</div>
            )}
          </>
        ) : loadingProject ? (
          <div className="loading-state"><LoaderCircle className="spin" />正在连接 Pi Agent…</div>
        ) : (
          <EmptyState />
        )}
        <Composer />
        <ActiveDialog />
        <ExtensionUiLayer />
      </main>
    </div>
  );
}
