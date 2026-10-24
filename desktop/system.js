// Windows integration that users can switch on and off from the tray menu.
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { app } = require('electron');

const execFileAsync = promisify(execFile);
const COMMANDS_DIR = path.join(__dirname, 'commands');
const AUTOSTART_ARGS = ['--hidden'];

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
  return process.platform === 'win32' && app.isPackaged;
}

function isAutostartEnabled() {
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin;
}

function setAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: AUTOSTART_ARGS });
}

async function readUserPath() {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { windowsHide: true });
    const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

async function areCommandsEnabled() {
  const entries = (await readUserPath()).split(';').map((entry) => entry.trim().toLowerCase());
  return entries.includes(COMMANDS_DIR.toLowerCase());
}

async function setCommands(enabled) {
  const encoded = Buffer.from(UPDATE_PATH_SCRIPT, 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    env: {
      ...process.env,
      DOWNLOADER_COMMANDS_DIR: COMMANDS_DIR,
      DOWNLOADER_COMMANDS_ENABLE: enabled ? '1' : '0',
    },
  });
}

module.exports = {
  isSupported,
  isAutostartEnabled,
  setAutostart,
  areCommandsEnabled,
  setCommands,
};
