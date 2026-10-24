const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');
const { version } = require('../package.json');

const ROOT_DIR = path.join(__dirname, '..');

// Local runtime data (downloads, yt-dlp, cookies, logs) must never end up in the packaged app.
const IGNORE = [
  /^\/downloads($|\/)/,
  /^\/bin($|\/)/,
  /^\/dist($|\/)/,
  /^\/scripts($|\/)/,
  /^\/docs($|\/)/,
  /^\/cookies\.txt$/,
  /^\/browser-check/,
  /\.log$/,
  /^\/\.git/,
  /^\/\.claude($|\/)/,
];

async function main() {
  const [appPath] = await packager({
    dir: ROOT_DIR,
    out: path.join(ROOT_DIR, 'dist'),
    name: 'Downloader',
    executableName: 'Downloader',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(ROOT_DIR, 'desktop', 'icon.ico'),
    asar: false,
    overwrite: true,
    prune: true,
    ignore: IGNORE,
    win32metadata: {
      ProductName: 'Downloader',
      FileDescription: 'Downloader',
      InternalName: 'Downloader',
    },
  });

  console.log(appPath);

  // --zip creates the archive attached to GitHub releases. Windows' bsdtar writes portable zip paths
  // (Compress-Archive in Windows PowerShell uses backslashes); the folder inside is named "Downloader".
  if (process.argv.includes('--zip')) {
    const zipPath = path.join(ROOT_DIR, 'dist', `Downloader-${version}-win-x64.zip`);
    const stagingDir = path.join(ROOT_DIR, 'dist', 'zip');
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.cpSync(appPath, path.join(stagingDir, 'Downloader'), { recursive: true });
    // Absolute path, so Git Bash's GNU tar (no zip support) is never picked up instead.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', stagingDir, 'Downloader'], { stdio: 'inherit' });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log(zipPath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
