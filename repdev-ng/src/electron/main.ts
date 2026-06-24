/**
 * Electron main process. Thin shell: creates the window, owns one EditorService
 * (which owns the Symitar sessions), and registers IPC. All real logic lives in
 * the tested EditorService / protocol layer.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EditorService } from '../app/editor-service.js';
import { GitMirror } from '../git/git-mirror.js';
import { registerIpc } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Git mirror lives under the app's user-data dir; the host stays the source
// of truth and every successful save is committed here with its compile verdict.
const mirror = new GitMirror(path.join(app.getPath('userData'), 'mirror'), process.env.USERNAME || 'RepDev NG');
const service = new EditorService(undefined, mirror);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'RepDev NG',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  await mirror.init();
  registerIpc(ipcMain, service);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void service.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
