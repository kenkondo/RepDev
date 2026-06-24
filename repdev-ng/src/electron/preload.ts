/**
 * Preload: exposes a typed, minimal RepDev API on window.repdev via
 * contextBridge. The renderer never touches Node or ipcRenderer directly.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, LOG_EVENT, type RepDevApi } from './ipc-contract.js';

const api: RepDevApi = {
  connect: (args) => ipcRenderer.invoke(IPC.connect, args),
  disconnect: (sym) => ipcRenderer.invoke(IPC.disconnect, sym),
  openFile: (file) => ipcRenderer.invoke(IPC.openFile, file),
  saveFile: (file, text, mode) => ipcRenderer.invoke(IPC.saveFile, file, text, mode),
  errorCheck: (sym, name) => ipcRenderer.invoke(IPC.errorCheck, sym, name),
  install: (sym, name) => ipcRenderer.invoke(IPC.install, sym, name),
  listFiles: (sym, type, search) => ipcRenderer.invoke(IPC.listFiles, sym, type, search),
  diff: (file) => ipcRenderer.invoke(IPC.diff, file),
  removeFile: (file) => ipcRenderer.invoke(IPC.removeFile, file),
  renameFile: (file, newName) => ipcRenderer.invoke(IPC.renameFile, file, newName),
  runBatchFM: (sym, searchTitle, searchDays, file, queue, resultTitle) =>
    ipcRenderer.invoke(IPC.runBatchFM, sym, searchTitle, searchDays, file, queue, resultTitle),
  isSeqRunning: (sym, seq) => ipcRenderer.invoke(IPC.isSeqRunning, sym, seq),
  getPrintItems: (sym, query, limit) => ipcRenderer.invoke(IPC.getPrintItems, sym, query, limit),
  getReportSeqs: (sym, reportName, time, search, limit) =>
    ipcRenderer.invoke(IPC.getReportSeqs, sym, reportName, time, search, limit),
  printFileLPT: (file, queue, opts) => ipcRenderer.invoke(IPC.printFileLPT, file, queue, opts),
  onLog: (callback) => {
    const listener = (_e: unknown, line: string) => callback(line);
    ipcRenderer.on(LOG_EVENT, listener);
    return () => ipcRenderer.removeListener(LOG_EVENT, listener);
  },
};

contextBridge.exposeInMainWorld('repdev', api);
