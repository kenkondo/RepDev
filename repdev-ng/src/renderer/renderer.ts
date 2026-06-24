/**
 * Renderer: mounts the Monaco editor and wires the toolbar to the RepDev IPC
 * API exposed on window.repdev. Diagnostics from the host compiler are shown as
 * Monaco markers (red squiggles).
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { FileType } from '../symitar/types.js';
import { diagnosticToMarker } from './markers.js';
import { loadLanguageData } from '../lang/data-loader.js';
import { registerRepgenLanguage, REPGEN_LANGUAGE_ID } from '../lang/repgen-monaco.js';
import keywordsTxt from '../lang/data/keywords.txt?raw';
import functionsTxt from '../lang/data/functions.txt?raw';
import varsTxt from '../lang/data/vars.txt?raw';
import dbTxt from '../lang/data/db.txt?raw';

// Monaco needs a worker; Vite bundles it via the ?worker import.
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Register the RepGen language with the real syntax/completion data.
const languageData = loadLanguageData({
  keywords: keywordsTxt,
  functions: functionsTxt,
  variables: varsTxt,
  database: dbTxt,
});
registerRepgenLanguage(monaco, languageData);

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById('status') as HTMLSpanElement;

const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: '',
  language: REPGEN_LANGUAGE_ID,
  theme: 'vs-dark',
  automaticLayout: true,
});

let currentSym = 0;

function setStatus(text: string): void {
  status.textContent = text;
}

// Live connection log: append lines pushed from the main process.
const logLines = document.getElementById('log-lines') as HTMLDivElement;
function appendLog(line: string): void {
  const ts = new Date().toLocaleTimeString();
  logLines.append(`${ts}  ${line}\n`);
  const panel = document.getElementById('logpanel') as HTMLDivElement;
  panel.scrollTop = panel.scrollHeight;
}
window.repdev.onLog(appendLog);
document.getElementById('log-clear')!.addEventListener('click', () => {
  logLines.textContent = '';
});

document.getElementById('connect')!.addEventListener('click', () => void connect());
document.getElementById('open')!.addEventListener('click', () => void openFile());
document.getElementById('save')!.addEventListener('click', () => void saveFile('check'));
document.getElementById('install')!.addEventListener('click', () => void saveFile('install'));
document.getElementById('diff')!.addEventListener('click', () => void showDiff());
document.getElementById('diff-close')!.addEventListener('click', () => {
  (document.getElementById('diff-overlay') as HTMLDivElement).style.display = 'none';
});

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

async function showDiff(): Promise<void> {
  const name = el('fileName').value;
  const result = await window.repdev.diff({ sym: currentSym, name, type: FileType.REPGEN });
  if (!result) {
    setStatus('No Git mirror configured');
    return;
  }
  const overlay = document.getElementById('diff-overlay') as HTMLDivElement;
  overlay.style.display = 'block';
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor')!, {
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: true,
    });
  }
  diffEditor.setModel({
    original: monaco.editor.createModel(result.committed ?? '', REPGEN_LANGUAGE_ID),
    modified: monaco.editor.createModel(result.host, REPGEN_LANGUAGE_ID),
  });
  setStatus(`Diff ${name}: Git (left) vs host (right)`);
}

async function connect(): Promise<void> {
  const sym = Number(el('sym').value);
  setStatus('Connecting…');
  const err = await window.repdev.connect({
    server: el('server').value,
    port: 22, // SSH only — telnet is not permitted
    aixUsername: el('aixUser').value,
    aixPassword: el('aixPass').value,
    sym,
    userID: el('userId').value,
  });
  if (err === 'NONE') {
    currentSym = sym;
    setStatus(`Connected to SYM ${sym}`);
  } else {
    setStatus(`Connect failed: ${err}`);
  }
}

async function openFile(): Promise<void> {
  const name = el('fileName').value;
  setStatus(`Opening ${name}…`);
  const data = await window.repdev.openFile({ sym: currentSym, name, type: FileType.REPGEN });
  if (data == null) {
    setStatus(`Could not open ${name}`);
    return;
  }
  editor.setValue(data);
  monaco.editor.setModelMarkers(editor.getModel()!, REPGEN_LANGUAGE_ID, []);
  setStatus(`Opened ${name}`);
}

async function saveFile(mode: 'check' | 'install'): Promise<void> {
  const name = el('fileName').value;
  setStatus(mode === 'install' ? `Saving + installing ${name}…` : `Saving ${name}…`);
  const res = await window.repdev.saveFile(
    { sym: currentSym, name, type: FileType.REPGEN },
    editor.getValue(),
    mode,
  );
  const markers = res.diagnostics.map(diagnosticToMarker);
  monaco.editor.setModelMarkers(editor.getModel()!, REPGEN_LANGUAGE_ID, markers);
  const committed = res.commit ? ` (git ${res.commit.slice(0, 7)})` : '';
  if (res.error !== 'NONE') {
    setStatus(`Save failed: ${res.error}`);
  } else if (res.installed) {
    setStatus(`Installed ${name} — size ${res.installSize}${committed} ✓`);
  } else if (res.clean) {
    setStatus(`Saved ${name} — checked clean${committed} ✓`);
  } else {
    setStatus(`Saved ${name} — ${res.diagnostics.length} compile error(s)${committed}`);
  }
}
