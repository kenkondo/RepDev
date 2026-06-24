/**
 * The IPC contract shared between the Electron main process and the renderer.
 *
 * Centralising channel names + payload shapes here keeps the preload bridge,
 * the main-process handlers, and the renderer in lock-step, and lets the wiring
 * be unit-tested without spinning up Electron.
 */
import type { ConnectOptions } from '../symitar/session.js';
import type {
  ErrorCheckResult,
  FMFile,
  FileType,
  PrintItem,
  SessionError,
  Sequence,
  SymitarFile,
} from '../symitar/types.js';
import type { PrintLptOptions, RunFMResult } from '../symitar/session.js';
import type { CompileMode, Diagnostic, SaveResult } from '../app/editor-service.js';

export const IPC = {
  connect: 'repdev:connect',
  disconnect: 'repdev:disconnect',
  openFile: 'repdev:openFile',
  saveFile: 'repdev:saveFile',
  errorCheck: 'repdev:errorCheck',
  install: 'repdev:install',
  listFiles: 'repdev:listFiles',
  diff: 'repdev:diff',
  removeFile: 'repdev:removeFile',
  renameFile: 'repdev:renameFile',
  runBatchFM: 'repdev:runBatchFM',
  isSeqRunning: 'repdev:isSeqRunning',
  getPrintItems: 'repdev:getPrintItems',
  getReportSeqs: 'repdev:getReportSeqs',
  printFileLPT: 'repdev:printFileLPT',
} as const;

/** Connect args are ConnectOptions minus the injectable transport (main owns sockets). */
export type ConnectArgs = Omit<ConnectOptions, 'transport'>;

export interface RepDevApi {
  connect(args: ConnectArgs): Promise<SessionError>;
  disconnect(sym: number): Promise<void>;
  openFile(file: SymitarFile): Promise<string | null>;
  saveFile(file: SymitarFile, text: string, mode?: CompileMode): Promise<SaveResult>;
  errorCheck(sym: number, name: string): Promise<Diagnostic[]>;
  install(sym: number, name: string): Promise<{ result: ErrorCheckResult | null; diagnostics: Diagnostic[] }>;
  listFiles(sym: number, type: FileType, search: string): Promise<SymitarFile[]>;
  diff(file: SymitarFile): Promise<{ committed: string | null; host: string } | null>;
  removeFile(file: SymitarFile): Promise<SessionError>;
  renameFile(file: SymitarFile, newName: string): Promise<SessionError>;
  runBatchFM(
    sym: number,
    searchTitle: string,
    searchDays: number,
    file: FMFile,
    queue: number,
    resultTitle?: string,
  ): Promise<RunFMResult>;
  isSeqRunning(sym: number, seq: number): Promise<boolean>;
  getPrintItems(sym: number, query: string, limit: number): Promise<PrintItem[]>;
  getReportSeqs(sym: number, reportName: string, time: number, search: number, limit: number): Promise<Sequence[]>;
  printFileLPT(file: SymitarFile, queue: number, opts?: PrintLptOptions): Promise<SessionError>;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    repdev: RepDevApi;
  }
}
