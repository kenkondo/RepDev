import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectManager } from '../src/app/project-manager.js';
import { FileType } from '../src/symitar/types.js';

let tmp: string;
let store: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'repdev-proj-'));
  store = path.join(tmp, 'projects.json');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('ProjectManager', () => {
  it('adds projects and files, dedupes, and filters by type', () => {
    const pm = new ProjectManager(store);
    pm.addFile('Nightly', 999, { sym: 999, name: 'A.RG', type: FileType.REPGEN });
    pm.addFile('Nightly', 999, { sym: 999, name: 'A.RG', type: FileType.REPGEN }); // dup
    pm.addFile('Nightly', 999, { sym: 999, name: 'WELCOME', type: FileType.LETTER });

    expect(pm.list()).toHaveLength(1);
    expect(pm.filesOfType('Nightly', 999, FileType.REPGEN)).toHaveLength(1);
    expect(pm.filesOfType('Nightly', 999, FileType.LETTER).map((f) => f.name)).toEqual(['WELCOME']);
  });

  it('removes files and projects', () => {
    const pm = new ProjectManager(store);
    pm.addFile('P', 1, { sym: 1, name: 'X.RG', type: FileType.REPGEN });
    pm.removeFile('P', 1, { sym: 1, name: 'X.RG', type: FileType.REPGEN });
    expect(pm.find('P', 1)?.files).toEqual([]);
    expect(pm.removeProject('P', 1)).toBe(true);
    expect(pm.list()).toEqual([]);
  });

  it('persists across save/load', async () => {
    const pm = new ProjectManager(store);
    pm.addFile('Saved', 5, { sym: 5, name: 'Y.RG', type: FileType.REPGEN });
    await pm.save();

    const reloaded = new ProjectManager(store);
    await reloaded.load();
    expect(reloaded.find('Saved', 5)?.files[0].name).toBe('Y.RG');
  });

  it('load tolerates a missing store', async () => {
    const pm = new ProjectManager(store);
    await pm.load();
    expect(pm.list()).toEqual([]);
  });
});
