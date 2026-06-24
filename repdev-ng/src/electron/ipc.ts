/**
 * Registers the main-process IPC handlers, delegating each channel to the
 * EditorService. Decoupled from the real `ipcMain` via a tiny interface so the
 * wiring can be unit-tested with a fake.
 */
import { EditorService } from '../app/editor-service.js';
import { IPC, type ConnectArgs } from './ipc-contract.js';
import type { CompileMode } from '../app/editor-service.js';
import type { PrintLptOptions } from '../symitar/session.js';
import type { FMFile, FileType, SymitarFile } from '../symitar/types.js';

/** The subset of Electron's ipcMain we use. */
export interface IpcHandlerRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

export function registerIpc(ipc: IpcHandlerRegistrar, service: EditorService): void {
  ipc.handle(IPC.connect, (_e, args: ConnectArgs) => service.connect(args));
  ipc.handle(IPC.disconnect, (_e, sym: number) => service.disconnect(sym));
  ipc.handle(IPC.openFile, (_e, file: SymitarFile) => service.openFile(file));
  ipc.handle(IPC.saveFile, (_e, file: SymitarFile, text: string, mode?: CompileMode) =>
    service.saveFile(file, text, mode),
  );
  ipc.handle(IPC.errorCheck, (_e, sym: number, name: string) => service.errorCheck(sym, name));
  ipc.handle(IPC.install, (_e, sym: number, name: string) => service.install(sym, name));
  ipc.handle(IPC.listFiles, (_e, sym: number, type: FileType, search: string) =>
    service.listFiles(sym, type, search),
  );
  ipc.handle(IPC.diff, (_e, file: SymitarFile) => service.diff(file));
  ipc.handle(IPC.removeFile, (_e, file: SymitarFile) => service.removeFile(file));
  ipc.handle(IPC.renameFile, (_e, file: SymitarFile, newName: string) =>
    service.renameFile(file, newName),
  );
  ipc.handle(
    IPC.runBatchFM,
    (_e, sym: number, searchTitle: string, searchDays: number, file: FMFile, queue: number, resultTitle?: string) =>
      service.runBatchFM(sym, searchTitle, searchDays, file, queue, resultTitle),
  );
  ipc.handle(IPC.isSeqRunning, (_e, sym: number, seq: number) => service.isSeqRunning(sym, seq));
  ipc.handle(IPC.getPrintItems, (_e, sym: number, query: string, limit: number) =>
    service.getPrintItems(sym, query, limit),
  );
  ipc.handle(
    IPC.getReportSeqs,
    (_e, sym: number, reportName: string, time: number, search: number, limit: number) =>
      service.getReportSeqs(sym, reportName, time, search, limit),
  );
  ipc.handle(IPC.printFileLPT, (_e, file: SymitarFile, queue: number, opts?: PrintLptOptions) =>
    service.printFileLPT(file, queue, opts),
  );
}
