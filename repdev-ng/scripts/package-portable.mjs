/**
 * Produces a portable, double-clickable RepDev NG bundle using @electron/packager.
 *
 * Why this instead of electron-builder: builder requires the winCodeSign cache,
 * which contains macOS symlinks that non-admin Windows users can't extract
 * (requires Developer Mode or admin). @electron/packager has none of that
 * baggage — it just lays Electron + our app down in a folder, ready to zip.
 *
 * Usage:
 *   npm run build && node scripts/package-portable.mjs [--out <dir>]
 *
 * Output: <out>/RepDev NG-win32-x64/, containing "RepDev NG.exe" plus all
 * resources. Zip that folder for distribution; users extract and double-click.
 */
import { packager } from '@electron/packager';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// Allow --out <dir> override; defaults to %LOCALAPPDATA%/repdev-ng-release
// (outside OneDrive, which intermittently locks freshly-written .exe files).
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const defaultOut =
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'repdev-ng-release')
    : path.join(repoRoot, 'release');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : defaultOut;

// Redirect the staging dir off of %TEMP% so Windows Defender's real-time scan
// doesn't briefly lock files mid-rename (the EPERM the previous run hit). A
// per-run staging dir is also easier to clean up than %TEMP%/electron-packager.
const stagingRoot = path.join(outDir, '.stage');
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
process.env.TEMP = stagingRoot;
process.env.TMP = stagingRoot;
// os.tmpdir() reads these on Windows; verify and surface the dir we chose.
console.log(`Staging dir: ${os.tmpdir()}`);

console.log(`Packaging ${pkg.name}@${pkg.version} -> ${outDir}`);

// Anything not under `out/` is dev-time only and must not ship.
const IGNORE_PATTERNS = [
  /^\/\.git($|\/)/,
  /^\/\.gitignore$/,
  /^\/\.vscode($|\/)/,
  /^\/src($|\/)/,
  /^\/test($|\/)/,
  /^\/scripts($|\/)/,
  /^\/build($|\/)/,
  /^\/release($|\/)/,
  /^\/tsconfig\.json$/,
  /^\/vitest\.config\.ts$/,
  /^\/electron\.vite\.config\.ts$/,
  /^\/README\.md$/,
  /\.map$/,
];

async function packageWithRetry(options, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await packager(options);
    } catch (err) {
      // EPERM/EBUSY mid-rename usually means Defender briefly held a file open;
      // a short backoff almost always clears it.
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY');
      if (!transient || i === attempts) throw err;
      const wait = 2000 * i;
      console.warn(`Attempt ${i} hit ${err.code}; retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

try {
  const appPaths = await packageWithRetry({
    dir: repoRoot,
    out: outDir,
    name: 'RepDev NG',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    prune: true, // strip devDependencies from the bundled node_modules
    asar: true,
    appCopyright: pkg.build?.copyright ?? `Copyright © ${pkg.author?.name ?? ''}`,
    appVersion: pkg.version,
    win32metadata: {
      CompanyName: pkg.author?.name ?? '',
      FileDescription: pkg.description,
      ProductName: 'RepDev NG',
    },
    ignore: IGNORE_PATTERNS,
  });

  // Clean up the staging dir we forced TEMP to point at.
  rmSync(stagingRoot, { recursive: true, force: true });

  console.log('\nPackaged to:');
  for (const p of appPaths) console.log('  ' + p);
  console.log('\nZip that folder and share it. Inside, double-click "RepDev NG.exe".');
} catch (err) {
  console.error('Packaging failed:', err);
  process.exit(1);
}
