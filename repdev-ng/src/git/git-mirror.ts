/**
 * GitMirror — keeps a local Git repository that mirrors what is saved to the
 * Symitar host. The host stays the source of truth (only it can compile a
 * RepGen); Git records every save together with the host's compile verdict, so
 * history answers "what changed, and did it compile?".
 *
 * This replaces the original folder-copy "source control" in
 * com/repdev/SourceControl.java with real version history.
 */
import { simpleGit, type SimpleGit } from 'simple-git';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SymitarFile } from '../symitar/types.js';
import type { SaveResult } from '../app/editor-service.js';

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
}

/**
 * Builds the commit message carrying the compile verdict. The verdict goes in
 * the subject line so it shows in `git log --oneline` and survives in the log's
 * `message` field.
 */
export function buildCommitMessage(file: SymitarFile, result: SaveResult, author: string): string {
  let verdict: string;
  if (result.error !== 'NONE') {
    verdict = `SAVE FAILED (${result.error})`;
  } else if (result.installed) {
    verdict = `Compile: INSTALLED (size ${result.installSize ?? '?'})`;
  } else if (result.clean) {
    verdict = 'Compile: NO_ERROR';
  } else {
    const d = result.diagnostics[0];
    verdict = d
      ? `Compile: ERROR line ${d.line} col ${d.column}: ${d.message}`
      : 'Compile: ERROR';
  }
  return `${file.name} [SYM ${file.sym}]: ${verdict}\n\nSaved by ${author} via RepDev NG.`;
}

export class GitMirror {
  private git: SimpleGit;

  constructor(
    private repoDir: string,
    private author = 'RepDev NG',
    private authorEmail = 'repdev@localhost',
  ) {
    this.git = simpleGit(repoDir);
  }

  /** Path within the mirror repo for a host file: <sym>/<TYPE>/<name>. */
  relPath(file: SymitarFile): string {
    return path.posix.join(String(file.sym), file.type, file.name);
  }

  /** Initialise the repo if it isn't one yet (idempotent). */
  async init(): Promise<void> {
    await mkdir(this.repoDir, { recursive: true });
    if (!(await this.git.checkIsRepo())) {
      await this.git.init();
    }
    await this.git.addConfig('user.name', this.author);
    await this.git.addConfig('user.email', this.authorEmail);
  }

  /**
   * Writes the saved content into the mirror and commits it with the compile
   * verdict. Returns the new commit hash, or null when the content was
   * unchanged (nothing to commit).
   */
  async commitSave(file: SymitarFile, content: string, result: SaveResult): Promise<string | null> {
    const rel = this.relPath(file);
    const abs = path.join(this.repoDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'latin1');

    await this.git.add(rel);
    const status = await this.git.status();
    if (status.staged.length === 0) return null; // identical to last commit

    const message = buildCommitMessage(file, result, this.author);
    const commit = await this.git.commit(message, undefined, {
      '--author': `${this.author} <${this.authorEmail}>`,
    });
    return commit.commit || null;
  }

  /** Content of a file at HEAD, or null if it was never committed. */
  async lastCommitted(file: SymitarFile): Promise<string | null> {
    const rel = this.relPath(file);
    try {
      return await this.git.show([`HEAD:${rel}`]);
    } catch {
      return null;
    }
  }

  /** Commit history (newest first) for a single mirrored file. */
  async history(file: SymitarFile): Promise<CommitInfo[]> {
    const rel = this.relPath(file);
    const log = await this.git.log({ file: rel });
    return log.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date }));
  }

  /** Convenience for the diff view: committed (HEAD) vs. live host content. */
  async diffAgainstHost(
    file: SymitarFile,
    hostContent: string,
  ): Promise<{ committed: string | null; host: string }> {
    return { committed: await this.lastCommitted(file), host: hostContent };
  }

  async readWorking(file: SymitarFile): Promise<string | null> {
    try {
      return await readFile(path.join(this.repoDir, this.relPath(file)), 'latin1');
    } catch {
      return null;
    }
  }
}
