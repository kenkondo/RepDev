/**
 * Electron main process. Thin shell: creates the window, owns one EditorService
 * (which owns the Symitar sessions), and registers IPC. All real logic lives in
 * the tested EditorService / protocol layer.
 *
 * Ordering matters: the window is created FIRST and unconditionally, so the UI
 * always appears. The Git mirror is initialised in the background and any
 * failure (e.g. Git not on PATH when launched from Explorer) is logged and the
 * mirror is disabled rather than blocking the whole app.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EditorService } from '../app/editor-service.js';
import { GitMirror } from '../git/git-mirror.js';
import { registerIpc } from './ipc.js';
import { LOG_EVENT } from './ipc-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Git mirror lives under the app's user-data dir; the host stays the source
// of truth and every successful save is committed here with its compile verdict.
const mirror = new GitMirror(path.join(app.getPath('userData'), 'mirror'), process.env.USERNAME || 'RepDev NG');
const service = new EditorService(undefined, mirror);

/** Append a line to a crash/diagnostics log in the user-data dir. */
function logToFile(label: string, detail: unknown): void {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${label}: ${detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)}\n`;
    appendFileSync(path.join(dir, 'repdev-ng.log'), line);
  } catch {
    /* logging must never throw */
  }
}

// Never let an unhandled error silently kill startup with no window.
process.on('uncaughtException', (err) => logToFile('uncaughtException', err));
process.on('unhandledRejection', (err) => logToFile('unhandledRejection', err));

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

  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    logToFile('did-fail-load', `${code} ${desc} ${url}`),
  );

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** Initialise the Git mirror in the background; degrade gracefully on failure. */
async function initMirror(): Promise<void> {
  try {
    await mirror.init();
  } catch (err) {
    logToFile('git-mirror-disabled', err);
    service.setMirror(undefined); // saves still work, just no Git history
    dialog.showErrorBox(
      'Git mirror disabled',
      'RepDev NG could not initialise its local Git mirror (is Git installed and on PATH?).\n\n' +
        'The app will run normally and save to the host, but changes will not be committed to Git.\n\n' +
        `Details logged to:\n${path.join(app.getPath('userData'), 'repdev-ng.log')}`,
    );
  }
}

/** Push a log line to every open window so it can be shown live in the UI. */
function broadcastLog(line: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(LOG_EVENT, line);
  }
}

app.whenReady().then(() => {
  // Route connection-handshake diagnostics to the log file AND the live UI panel.
  service.setConnectLogger((m) => {
    logToFile('connect', m);
    broadcastLog(m);
  });
  registerIpc(ipcMain, service);
  createWindow();
  void initMirror(); // background — does not block the window

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void service.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
