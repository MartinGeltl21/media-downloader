// Operating system integration that users can switch on and off from the tray menu:
// starting at login and the mp3/video console commands.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { app } = require('electron');

const execFileAsync = promisify(execFile);
const COMMANDS = { mp3: 'mp3', video: 'mp4' };
const AUTOSTART_ARGS = ['--hidden'];

// Windows: .cmd files shipped with the app, whose folder is added to the user PATH.
const WINDOWS_COMMANDS_DIR = path.join(__dirname, 'commands');

// macOS and Linux: small shell scripts in ~/.local/bin, recognised by this marker line.
const UNIX_COMMANDS_DIR = path.join(os.homedir(), '.local', 'bin');
const COMMAND_MARKER = '# Created by Downloader. Turn off "Console commands" in its tray menu to remove.';
const ZPROFILE = path.join(os.homedir(), '.zprofile');
const ZPROFILE_BLOCK_START = '# >>> Downloader console commands >>>';
const ZPROFILE_BLOCK_END = '# <<< Downloader console commands <<<';

// Reads the raw user PATH, adds or removes the commands folder, keeps %VARIABLES% unexpanded,
// and notifies Explorer so new terminals pick up the change.
const UPDATE_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = $env:DOWNLOADER_COMMANDS_DIR
$key = Get-Item 'HKCU:\\Environment'
$entries = @($key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ -and $_ -ne $dir })
if ($env:DOWNLOADER_COMMANDS_ENABLE -eq '1') { $entries += $dir }
Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value ($entries -join ';') -Type ExpandString
Add-Type -Namespace Downloader -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$result = [UIntPtr]::Zero
[void][Downloader.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`;

function isSupported() {
  return app.isPackaged && ['win32', 'darwin', 'linux'].includes(process.platform);
}

function getAutostartLabel() {
  return process.platform === 'win32' ? 'Start with Windows' : 'Open at login';
}

// An AppImage runs from a temporary mount, so commands and autostart must point to the AppImage file.
function getLauncherPath() {
  return process.env.APPIMAGE || process.execPath;
}

function getLinuxAutostartFile() {
  return path.join(app.getPath('appData'), 'autostart', 'downloader.desktop');
}

// macOS cannot pass --hidden to login items, so the app asks how it was opened instead.
function wasOpenedAtLogin() {
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function isAutostartEnabled() {
  if (process.platform === 'linux') {
    return fs.existsSync(getLinuxAutostartFile());
  }

  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin;
  }

  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin;
}

async function setAutostart(enabled) {
  if (process.platform === 'linux') {
    const file = getLinuxAutostartFile();
    if (!enabled) {
      await fsp.rm(file, { force: true });
      return;
    }

    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Downloader',
      'Comment=Save links as MP4, MP3, or WAV',
      `Exec="${getLauncherPath()}" ${AUTOSTART_ARGS.join(' ')}`,
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
    return;
  }

  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }

  app.setLoginItemSettings({ openAtLogin: enabled, args: AUTOSTART_ARGS });
}

async function readWindowsUserPath() {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { windowsHide: true });
    const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function isOwnCommand(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(COMMAND_MARKER);
  } catch {
    return false;
  }
}

async function areCommandsEnabled() {
  if (process.platform === 'win32') {
    const entries = (await readWindowsUserPath()).split(';').map((entry) => entry.trim().toLowerCase());
    return entries.includes(WINDOWS_COMMANDS_DIR.toLowerCase());
  }

  return Object.keys(COMMANDS).every((name) => isOwnCommand(path.join(UNIX_COMMANDS_DIR, name)));
}

async function setWindowsCommands(enabled) {
  const encoded = Buffer.from(UPDATE_PATH_SCRIPT, 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    env: {
      ...process.env,
      DOWNLOADER_COMMANDS_DIR: WINDOWS_COMMANDS_DIR,
      DOWNLOADER_COMMANDS_ENABLE: enabled ? '1' : '0',
    },
  });
}

// zsh on macOS does not include ~/.local/bin, so a marked block in ~/.zprofile adds it.
async function setZprofileBlock(enabled) {
  let content = '';
  try {
    content = await fsp.readFile(ZPROFILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const start = content.indexOf(ZPROFILE_BLOCK_START);
  const end = content.indexOf(ZPROFILE_BLOCK_END);
  if (start !== -1 && end !== -1) {
    content = content.slice(0, start) + content.slice(end + ZPROFILE_BLOCK_END.length).replace(/^\n/, '');
  }

  if (enabled) {
    const block = `${ZPROFILE_BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${ZPROFILE_BLOCK_END}\n`;
    content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${block}`;
  }

  await fsp.writeFile(ZPROFILE, content);
}

async function setUnixCommands(enabled) {
  const files = Object.keys(COMMANDS).map((name) => path.join(UNIX_COMMANDS_DIR, name));

  if (!enabled) {
    await Promise.all(files.filter(isOwnCommand).map((file) => fsp.rm(file, { force: true })));
    if (process.platform === 'darwin') {
      await setZprofileBlock(false);
    }
    return;
  }

  const foreign = files.find((file) => fs.existsSync(file) && !isOwnCommand(file));
  if (foreign) {
    throw new Error(`${foreign} already exists and was not created by Downloader.`);
  }

  await fsp.mkdir(UNIX_COMMANDS_DIR, { recursive: true });
  await Promise.all(Object.entries(COMMANDS).map(([name, preset]) => fsp.writeFile(
    path.join(UNIX_COMMANDS_DIR, name),
    `#!/bin/sh\n${COMMAND_MARKER}\nnohup "${getLauncherPath()}" --preset=${preset} >/dev/null 2>&1 &\n`,
    { mode: 0o755 }
  )));

  if (process.platform === 'darwin') {
    await setZprofileBlock(true);
  }
}

async function setCommands(enabled) {
  if (process.platform === 'win32') {
    await setWindowsCommands(enabled);
  } else {
    await setUnixCommands(enabled);
  }
}

module.exports = {
  isSupported,
  getAutostartLabel,
  wasOpenedAtLogin,
  isAutostartEnabled,
  setAutostart,
  areCommandsEnabled,
  setCommands,
};
