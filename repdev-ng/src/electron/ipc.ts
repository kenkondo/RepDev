/**
 * Registers the main-process IPC handlers, delegating each channel to the
 * EditorService. Decoupled from the real `ipcMain` via a tiny interface so the
 * wiring can be unit-tested with a fake.
 */
import { EditorService } from '../app/editor-service.js';
import { ProjectManager } from '../app/project-manager.js';
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
  ipc.handle(IPC.setVerbose, (_e, on: boolean) => service.setVerbose(on));
}

/** Registers project CRUD handlers, persisting after each mutation. */
export function registerProjectIpc(ipc: IpcHandlerRegistrar, projects: ProjectManager): void {
  const persist = async (): Promise<void> => {
    await projects.save();
  };
  ipc.handle(IPC.projectsList, () => projects.list());
  ipc.handle(IPC.projectCreate, async (_e, name: string, sym: number) => {
    const p = projects.addProject(name, sym);
    await persist();
    return p;
  });
  ipc.handle(IPC.projectDelete, async (_e, name: string, sym: number) => {
    const ok = projects.removeProject(name, sym);
    await persist();
    return ok;
  });
  ipc.handle(IPC.projectAddFile, async (_e, name: string, sym: number, file: SymitarFile) => {
    projects.addFile(name, sym, file);
    await persist();
  });
  ipc.handle(IPC.projectRemoveFile, async (_e, name: string, sym: number, file: SymitarFile) => {
    projects.removeFile(name, sym, file);
    await persist();
  });
}
