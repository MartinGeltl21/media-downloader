// Packages the desktop app for the current platform, or for --platform=win32|darwin|linux and --arch=x64|arm64.
// --zip also creates the archive attached to GitHub releases.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');
const { version } = require('../package.json');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

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

const OS_NAMES = { win32: 'win', darwin: 'mac', linux: 'linux' };

function getOption(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

// Copies the build into dist/staging/Downloader so the archive contains a plainly named folder.
function stage(appPath) {
  const stagingDir = path.join(DIST_DIR, 'staging');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.cpSync(appPath, path.join(stagingDir, 'Downloader'), { recursive: true, verbatimSymlinks: true });
  return stagingDir;
}

function createArchive(platform, arch, appPath) {
  const baseName = `Downloader-${version}-${OS_NAMES[platform]}-${arch}`;

  if (platform === 'darwin') {
    // ditto keeps the symlinks and extended attributes inside the .app bundle.
    const archive = path.join(DIST_DIR, `${baseName}.zip`);
    fs.rmSync(archive, { force: true });
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(appPath, 'Downloader.app'), archive], { stdio: 'inherit' });
    return archive;
  }

  const stagingDir = stage(appPath);
  let archive;
  if (platform === 'linux') {
    // tar keeps the executable bits that a zip would lose.
    archive = path.join(DIST_DIR, `${baseName}.tar.gz`);
    fs.rmSync(archive, { force: true });
    execFileSync('tar', ['-czf', archive, '-C', stagingDir, 'Downloader'], { stdio: 'inherit' });
  } else {
    // Windows' bsdtar writes portable zip paths; Compress-Archive in Windows PowerShell uses backslashes.
    // The absolute path avoids Git Bash's GNU tar, which cannot write zip files.
    archive = path.join(DIST_DIR, `${baseName}.zip`);
    fs.rmSync(archive, { force: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', archive, '-C', stagingDir, 'Downloader'], { stdio: 'inherit' });
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });
  return archive;
}

async function main() {
  const platform = getOption('platform', process.platform);
  const arch = getOption('arch', process.arch);

  const [appPath] = await packager({
    dir: ROOT_DIR,
    out: DIST_DIR,
    name: 'Downloader',
    executableName: 'Downloader',
    platform,
    arch,
    // Without an extension, the packager picks icon.ico on Windows and icon.icns on macOS.
    icon: path.join(ROOT_DIR, 'desktop', 'icon'),
    asar: false,
    overwrite: true,
    prune: true,
    ignore: IGNORE,
    appBundleId: 'io.github.martingeltl21.downloader',
    appCategoryType: 'public.app-category.utilities',
    win32metadata: {
      ProductName: 'Downloader',
      FileDescription: 'Downloader',
      InternalName: 'Downloader',
    },
  });

  // Apple Silicon refuses to start unsigned apps and reports them as damaged; an ad-hoc signature is enough.
  if (platform === 'darwin' && process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(appPath, 'Downloader.app')], { stdio: 'inherit' });
  }

  console.log(appPath);

  if (process.argv.includes('--zip')) {
    console.log(createArchive(platform, arch, appPath));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
