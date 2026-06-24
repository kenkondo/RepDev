/**
 * EditorService — the framework-agnostic core the Electron main process wraps.
 *
 * It owns the per-SYM Symitar sessions and exposes the operations the editor UI
 * needs: connect, open, save (which also error-checks and returns diagnostics),
 * error-check on demand, and list. Keeping this independent of Electron/Monaco
 * makes the open->edit->save->diagnostics flow testable against the mock host.
 */
import {
  DirectSymitarSession,
  type ConnectOptions,
  type PrintLptOptions,
  type RunFMResult,
  type RunRepgenOptions,
  type RunRepgenResult,
} from '../symitar/session.js';
import {
  ErrorCheckResult,
  ErrorCheckType,
  FMFile,
  FileType,
  PrintItem,
  SessionError,
  Sequence,
  type SymitarFile,
} from '../symitar/types.js';

/** Editor-agnostic diagnostic; the renderer maps this to a Monaco marker. */
export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface SaveResult {
  error: SessionError;
  /** Host compile diagnostics produced after the save (empty == clean). */
  diagnostics: Diagnostic[];
  /** True when the host reported no errors — the signal Git uses to commit. */
  clean: boolean;
  /** True when the RepGen was actually compiled+installed on the host (option 8). */
  installed?: boolean;
  /** Installed object size reported by the host (only when installed). */
  installSize?: number;
  /** Mirror commit hash when the save was recorded to Git, else null/undefined. */
  commit?: string | null;
}

/** How saveFile verifies a RepGen on the host after writing it. */
export type CompileMode = 'check' | 'install';

/** What EditorService needs from a Git mirror; satisfied by GitMirror. */
export interface SaveMirror {
  commitSave(file: SymitarFile, content: string, result: SaveResult): Promise<string | null>;
  diffAgainstHost(
    file: SymitarFile,
    hostContent: string,
  ): Promise<{ committed: string | null; host: string }>;
}

/** Maps a host ErrorCheckResult into 0+ editor diagnostics. */
export function toDiagnostics(res: ErrorCheckResult | null): Diagnostic[] {
  if (!res) return [];
  if (res.type === ErrorCheckType.NO_ERROR || res.type === ErrorCheckType.INSTALLED_SUCCESSFULLY) {
    return [];
  }
  return [
    {
      line: res.lineNumber > 0 ? res.lineNumber : 1,
      column: res.column > 0 ? res.column : 1,
      message: res.errorMessage || 'Error checking specfile',
      severity: res.type === ErrorCheckType.WARNING ? 'warning' : 'error',
    },
  ];
}

export class EditorService {
  private sessions = new Map<number, DirectSymitarSession>();

  /**
   * @param sessionFactory test seam for injecting sessions bound to a mock transport
   * @param mirror optional Git mirror; when present, every successful host save is committed
   */
  constructor(
    private sessionFactory: () => DirectSymitarSession = () => new DirectSymitarSession(),
    private mirror?: SaveMirror,
  ) {}

  private connectLogger?: (message: string) => void;
  private verbose = false;

  /** Enable/disable the Git mirror at runtime (e.g. disable if Git is missing). */
  setMirror(mirror?: SaveMirror): void {
    this.mirror = mirror;
  }

  /** Toggle verbose protocol logging across all current and future sessions. */
  setVerbose(on: boolean): void {
    this.verbose = on;
    for (const s of this.sessions.values()) s.setVerbose(on);
  }

  /** Diagnostics sink applied to every connect() handshake. */
  setConnectLogger(logger?: (message: string) => void): void {
    this.connectLogger = logger;
  }

  async connect(opts: ConnectOptions): Promise<SessionError> {
    if (this.sessions.has(opts.sym)) return SessionError.ALREADY_CONNECTED;
    const session = this.sessionFactory();
    session.setVerbose(this.verbose);
    const err = await session.connect({ onLog: this.connectLogger, ...opts });
    if (err === SessionError.NONE) this.sessions.set(opts.sym, session);
    return err;
  }

  isConnected(sym: number): boolean {
    return this.sessions.get(sym)?.isConnected() ?? false;
  }

  private require(sym: number): DirectSymitarSession {
    const s = this.sessions.get(sym);
    if (!s) throw new Error(`Not connected to SYM ${sym}`);
    return s;
  }

  async openFile(file: SymitarFile): Promise<string | null> {
    return this.require(file.sym).getFile(file);
  }

  async listFiles(sym: number, type: FileType, search: string): Promise<SymitarFile[]> {
    return this.require(sym).getFileList(type, search);
  }

  async errorCheck(sym: number, name: string): Promise<Diagnostic[]> {
    return toDiagnostics(await this.require(sym).errorCheckRepGen(name));
  }

  /**
   * Compiles AND installs a RepGen on the host (Management Menu option 8) — the
   * real "make it live" path. Returns the host result (with install size) and
   * the editor diagnostics derived from it.
   */
  async install(
    sym: number,
    name: string,
  ): Promise<{ result: ErrorCheckResult | null; diagnostics: Diagnostic[] }> {
    const result = await this.require(sym).installRepgen(name);
    return { result, diagnostics: toDiagnostics(result) };
  }

  /**
   * Saves to the host and, for RepGens, verifies it: either a lightweight
   * error-check (default) or a full compile+install. The `clean` flag is what
   * the Git mirror keys off of.
   */
  async saveFile(file: SymitarFile, text: string, mode: CompileMode = 'check'): Promise<SaveResult> {
    const session = this.require(file.sym);
    const error = await session.saveFile(file, text);
    if (error !== SessionError.NONE) {
      return { error, diagnostics: [], clean: false };
    }

    let result: SaveResult;
    if (file.type !== FileType.REPGEN) {
      result = { error, diagnostics: [], clean: true };
    } else if (mode === 'install') {
      const res = await session.installRepgen(file.name);
      const diagnostics = toDiagnostics(res);
      result = {
        error,
        diagnostics,
        clean: diagnostics.length === 0,
        installed: res?.type === ErrorCheckType.INSTALLED_SUCCESSFULLY,
        installSize: res?.installSize,
      };
    } else {
      const diagnostics = toDiagnostics(await session.errorCheckRepGen(file.name));
      result = { error, diagnostics, clean: diagnostics.length === 0 };
    }

    // Mirror to Git: the host save succeeded, so record it with its verdict —
    // including error verdicts, so history shows what failed to compile/install.
    // A mirror failure (e.g. Git not installed) must never break the host save.
    if (this.mirror) {
      try {
        result.commit = await this.mirror.commitSave(file, text, result);
      } catch {
        result.commit = null;
      }
    }
    return result;
  }

  async removeFile(file: SymitarFile): Promise<SessionError> {
    return this.require(file.sym).removeFile(file);
  }

  async renameFile(file: SymitarFile, newName: string): Promise<SessionError> {
    return this.require(file.sym).renameFile(file, newName);
  }

  async runRepGen(
    sym: number,
    name: string,
    queue: number,
    opts?: RunRepgenOptions,
  ): Promise<RunRepgenResult> {
    return this.require(sym).runRepGen(name, queue, opts);
  }

  async runBatchFM(
    sym: number,
    searchTitle: string,
    searchDays: number,
    file: FMFile,
    queue: number,
    resultTitle?: string,
  ): Promise<RunFMResult> {
    return this.require(sym).runBatchFM(searchTitle, searchDays, file, queue, resultTitle);
  }

  async isSeqRunning(sym: number, seq: number): Promise<boolean> {
    return this.require(sym).isSeqRunning(seq);
  }

  async getPrintItems(sym: number, query: string, limit: number): Promise<PrintItem[]> {
    return this.require(sym).getPrintItems(query, limit);
  }

  async getReportSeqs(
    sym: number,
    reportName: string,
    time: number,
    search: number,
    limit: number,
  ): Promise<Sequence[]> {
    return this.require(sym).getReportSeqs(reportName, time, search, limit);
  }

  async printFileLPT(file: SymitarFile, queue: number, opts?: PrintLptOptions): Promise<SessionError> {
    return this.require(file.sym).printFileLPT(file, queue, opts);
  }

  /** Live host content vs. the last Git-mirrored commit (for the diff view). */
  async diff(file: SymitarFile): Promise<{ committed: string | null; host: string } | null> {
    if (!this.mirror) return null;
    const host = await this.openFile(file);
    return this.mirror.diffAgainstHost(file, host ?? '');
  }

  async disconnect(sym: number): Promise<void> {
    const s = this.sessions.get(sym);
    if (s) {
      await s.disconnect();
      this.sessions.delete(sym);
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sym) => this.disconnect(sym)));
  }
}
