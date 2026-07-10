/**
 * Zips the most recently packaged RepDev NG folder into a single distributable.
 *
 * Run AFTER `npm run package`. Produces e.g.
 *   <out>/RepDev-NG-0.1.0-win32-x64.zip
 *
 * Usage:
 *   node scripts/zip-bundle.mjs [--in <pkg-dir>] [--out <zip-path>]
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};

const defaultIn = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'repdev-ng-release', 'RepDev NG-win32-x64')
  : path.join(repoRoot, 'release', 'RepDev NG-win32-x64');

const inDir = arg('--in', defaultIn);
const outZip = arg('--out', path.join(path.dirname(inDir), `RepDev-NG-${pkg.version}-win32-x64.zip`));

if (!existsSync(inDir)) {
  console.error(`Bundle not found at ${inDir}. Run \`npm run package\` first.`);
  process.exit(1);
}

console.log(`Zipping ${inDir}`);
console.log(`     -> ${outZip}`);

// Use `tar` (bsdtar on Windows 10+) — it ships with the OS, handles spaces in
// paths, and tolerates pre-1980 file timestamps that PowerShell's
// Compress-Archive refuses. `-a` picks the archive format from the extension.
// We chdir into the parent first because bsdtar parses `tar -f C:\path` as an
// SCP-style "C" host (rsh:foo) — cwd + relative names sidesteps that.
const parent = path.dirname(inDir);
const base = path.basename(inDir);
const zipName = path.basename(outZip);
execSync(`tar -a -c -f "${zipName}" "${base}"`, { stdio: 'inherit', cwd: parent });


const sizeMB = (statSync(outZip).size / (1024 * 1024)).toFixed(1);
console.log(`\nDone. ${sizeMB} MB`);
