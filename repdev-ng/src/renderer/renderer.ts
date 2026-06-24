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

// ---- form persistence + saved connection profiles -------------------------
// Stored in localStorage (the app's user-data dir, local to this machine).
const FIELD_IDS = ['server', 'aixUser', 'aixPass', 'sym', 'userId', 'fileName'] as const;
const SECRET_IDS = new Set(['aixPass', 'userId']);
const LAST_KEY = 'repdev:last';
const PROFILES_KEY = 'repdev:profiles';
type FieldMap = Record<string, string>;

function rememberPasswords(): boolean {
  return (document.getElementById('remember-pw') as HTMLInputElement).checked;
}

function readFields(): FieldMap {
  const out: FieldMap = {};
  for (const id of FIELD_IDS) {
    const keep = !SECRET_IDS.has(id) || rememberPasswords();
    out[id] = keep ? el(id).value : '';
  }
  return out;
}

function writeFields(data: FieldMap): void {
  for (const id of FIELD_IDS) {
    if (data[id] !== undefined) el(id).value = data[id];
  }
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Persist the current form (called on every edit + on connect). */
function persistLast(): void {
  localStorage.setItem(LAST_KEY, JSON.stringify(readFields()));
}

function getProfiles(): Record<string, FieldMap> {
  return loadJSON<Record<string, FieldMap>>(PROFILES_KEY, {});
}

function refreshProfileList(selected = ''): void {
  const sel = document.getElementById('profile') as HTMLSelectElement;
  const names = Object.keys(getProfiles()).sort();
  sel.innerHTML = '<option value="">— last used —</option>';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    sel.append(opt);
  }
}

function initConfigUI(): void {
  // Restore last-used values, then wire persistence + profile controls.
  writeFields(loadJSON<FieldMap>(LAST_KEY, {}));
  refreshProfileList();

  for (const id of FIELD_IDS) el(id).addEventListener('input', persistLast);

  (document.getElementById('profile') as HTMLSelectElement).addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (!name) return;
    const profile = getProfiles()[name];
    if (profile) {
      writeFields(profile);
      (document.getElementById('profileName') as HTMLInputElement).value = name;
      persistLast();
    }
  });

  document.getElementById('save-profile')!.addEventListener('click', () => {
    const nameInput = document.getElementById('profileName') as HTMLInputElement;
    const name = nameInput.value.trim();
    if (!name) {
      setStatus('Enter a profile name to save');
      return;
    }
    const profiles = getProfiles();
    profiles[name] = readFields();
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    refreshProfileList(name);
    setStatus(`Saved profile "${name}"`);
  });

  document.getElementById('del-profile')!.addEventListener('click', () => {
    const sel = document.getElementById('profile') as HTMLSelectElement;
    const name = sel.value;
    if (!name) return;
    const profiles = getProfiles();
    delete profiles[name];
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    refreshProfileList();
    setStatus(`Deleted profile "${name}"`);
  });
}

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

initConfigUI(); // restore saved fields + wire profile controls

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
  persistLast(); // keep the entered values even if the connection fails
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
