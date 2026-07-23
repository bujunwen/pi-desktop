import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProjectRecord, ProjectTrust } from "../shared/contracts";

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return projects.sort((a, b) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export class ProjectStore {
  readonly #filePath: string;

  constructor(userDataPath: string) {
    this.#filePath = join(userDataPath, "projects.json");
  }

  async list(): Promise<ProjectRecord[]> {
    try {
      const contents = await readFile(this.#filePath, "utf8");
      return sortProjects(JSON.parse(contents) as ProjectRecord[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async add(path: string, trust: ProjectTrust): Promise<ProjectRecord> {
    const projects = await this.list();
    const now = new Date().toISOString();
    const existing = projects.find((project) => project.path === path);

    if (existing) {
      existing.trust = trust;
      existing.lastOpenedAt = now;
      await this.#save(sortProjects(projects));
      return existing;
    }

    const project: ProjectRecord = {
      id: randomUUID(),
      name: basename(path),
      path,
      trust,
      createdAt: now,
      lastOpenedAt: now,
    };
    projects.unshift(project);
    await this.#save(sortProjects(projects));
    return project;
  }

  async get(projectId: string): Promise<ProjectRecord> {
    const projects = await this.list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  async remove(projectId: string): Promise<void> {
    const projects = await this.list();
    await this.#save(projects.filter((project) => project.id !== projectId));
  }

  async setPinned(projectId: string, pinned: boolean): Promise<ProjectRecord[]> {
    const projects = await this.list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    project.pinned = pinned;
    const sorted = sortProjects(projects);
    await this.#save(sorted);
    return sorted;
  }

  async touch(projectId: string): Promise<ProjectRecord> {
    const projects = await this.list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    project.lastOpenedAt = new Date().toISOString();
    await this.#save(sortProjects(projects));
    return project;
  }

  async #save(projects: ProjectRecord[]): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#filePath);
  }
}
