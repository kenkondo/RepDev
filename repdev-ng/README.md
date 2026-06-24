# RepDev NG

A ground-up rewrite of [RepDev](../README.md) — the RepGen IDE for Symitar/Episys
credit unions — moving off Java/SWT onto **Electron + TypeScript + Monaco**, with
**Git** as a first-class mirror of the host.

The original Java app is preserved in `../com/repdev/`. This project ports the
parts that are genuinely RepDev-specific (the Symitar wire protocol and the
RepGen language knowledge) and lets the editor host (Monaco) and Git supply
everything that used to be hand-built SWT.

## Architecture

```
Renderer (Monaco editor, diagnostics, diff)  ──IPC──┐
                                                     ▼
Main process (Electron / Node)
  ├─ EditorService          session + file orchestration (tested)
  ├─ symitar/  ............. Symitar host protocol (ported from DirectSymitarSession)
  └─ git mirror  ........... auto-commit on clean save (Phase 4)
        │ Telnet/SSH                 │ push
        ▼                            ▼
   Symitar host (compiles)      Git remote (history/audit)
```

The Symitar **host stays the source of truth** — only the host can compile/
error-check a RepGen — so Git mirrors the host: every clean save is committed
with the host's compile verdict in the message.

## Status by phase

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Symitar protocol port (connect/getFile/saveFile/errorCheck) | ✅ round-trips against a mock host over a real socket |
| 2 | Editor shell: Electron + Monaco, open/edit/save, diagnostics | ✅ service+IPC tested, full app bundles |
| 3 | RepGen language: grammar + completions from the `*.txt` data | ✅ loaders parse the real data files; language registered |
| 4 | Git mirror: auto-commit on save + host-vs-commit diff | ✅ tested against a real git repo |
| 5 | Feature parity: projects, run report, install/compile, batch FM, print-control, find-output, remove/rename, multi-SYM | ✅ full session API ported + tested |

**Compile/install:** `installRepgen` (Management Menu #3 **option 8**) is the
real compile-and-install path — it makes the RepGen live on the host and returns
the installed object size, or the same line/col/message error block as the
option-7 check. The editor's **Save + Install** button runs it; a successful
install is mirrored to Git with `Compile: INSTALLED (size N)` in the message.

**Verification:** `npm test` → 74 tests across 12 files (protocol framing, full
session round-trips, editor service, IPC, language data, Git mirror against a
real repo, runRepGen, installRepgen, runBatchFM, print-control, getReportSeqs,
projects, multi-SYM). `npm run typecheck` and `npm run build` both pass. The one
thing this environment can't do is launch the Electron **window** (no
display/binary in CI) — the GUI is thin glue over the tested service layer; run
`npm run dev` locally to see it.

### Full session API
The TypeScript `SymitarSession` now mirrors the Java `DirectSymitarSession`:
connect/login, get/save/list/remove/rename files, errorCheck **and** install
(compile), runRepGen (with prompts + progress), runBatchFM, isSeqRunning,
getPrintItems (+ by-batch), printFileLPT, and getReportSeqs/getFMSeqs.
`printFileTPT`/`terminateRepgen` are kept as no-op stubs to match upstream,
which never implemented them. Interactive `runRepGen` prompting is exposed at
the service layer; an event-based IPC bridge for live prompts is the one
remaining UI wiring task.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit over all sources
npm test            # vitest: protocol + service round-trips vs. mock host
npm run dev         # launches the Electron window with HMR
```

The protocol layer is covered by a mock Symitar host (`test/mock-host.ts`) that
speaks the real wire framing, so tests need no live Episys box.

## Package a standalone build

```bash
npm run package      # builds + lays down %LOCALAPPDATA%/repdev-ng-release/RepDev NG-win32-x64/
npm run package:zip  # same, plus zips it to RepDev-NG-<ver>-win32-x64.zip
```

The output is a folder containing `RepDev NG.exe` and all dependencies —
double-click to run, no installer, no admin needed. Hand off the `.zip`
(~278 MB) to anyone on Windows x64.

**Why we don't use electron-builder** (despite the legacy config still being in
`package.json`): it needs its `winCodeSign` cache, which contains macOS symlinks
that non-admin Windows users can't extract. `@electron/packager` has none of
that and produces an equivalent portable bundle.

**Build environment caveats** the script handles for you:
- The staging dir is forced outside `%TEMP%` so Defender's real-time scan
  doesn't briefly lock files mid-rename. The script retries `EPERM`/`EBUSY`
  anyway with exponential backoff.
- The default output is `%LOCALAPPDATA%/repdev-ng-release/` — *not* under
  OneDrive, which has caused intermittent file-locking issues during this
  project. Override with `node scripts/package-portable.mjs --out <dir>` if you
  want elsewhere.

**Runtime dependency:** the Git mirror feature shells out to the system `git`
command. Targets need git on PATH (most dev machines do already). The app
itself is otherwise fully self-contained.

**Icon:** none currently — the original RepDev only shipped a 32×32 .ico and
electron-packager refuses anything under 256×256. Drop a `build/icon.ico` (≥
256×256) and uncomment `icon: 'build/icon.ico'` in the packager call to use it.
