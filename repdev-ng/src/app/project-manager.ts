/**
 * Projects group related host files (RepGens, letters, help, data) under a name
 * for a given SYM, ported from com/repdev/Project.java + ProjectManager.java.
 * The original persisted to XML; this uses JSON in the app's user-data dir.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileType, SymitarFile } from '../symitar/types.js';

export interface Project {
  name: string;
  sym: number;
  files: SymitarFile[];
}

function sameFile(a: SymitarFile, b: SymitarFile): boolean {
  return a.sym === b.sym && a.name === b.name && a.type === b.type;
}

export class ProjectManager {
  private projects: Project[] = [];

  constructor(private storePath: string) {}

  list(): Project[] {
    return this.projects;
  }

  find(name: string, sym: number): Project | undefined {
    return this.projects.find((p) => p.name === name && p.sym === sym);
  }

  addProject(name: string, sym: number): Project {
    const existing = this.find(name, sym);
    if (existing) return existing;
    const project: Project = { name, sym, files: [] };
    this.projects.push(project);
    return project;
  }

  removeProject(name: string, sym: number): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => !(p.name === name && p.sym === sym));
    return this.projects.length !== before;
  }

  addFile(name: string, sym: number, file: SymitarFile): void {
    const project = this.addProject(name, sym);
    if (!project.files.some((f) => sameFile(f, file))) project.files.push(file);
  }

  removeFile(name: string, sym: number, file: SymitarFile): void {
    const project = this.find(name, sym);
    if (project) project.files = project.files.filter((f) => !sameFile(f, file));
  }

  filesOfType(name: string, sym: number, type: FileType): SymitarFile[] {
    return this.find(name, sym)?.files.filter((f) => f.type === type) ?? [];
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as { projects?: Project[] };
      this.projects = parsed.projects ?? [];
    } catch {
      this.projects = []; // no store yet
    }
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify({ projects: this.projects }, null, 2), 'utf8');
  }
}
