const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeTheme, shell } = require('electron');
const system = require('./system');

// A fixed name keeps settings in %APPDATA%\Downloader regardless of the package name.
app.setPath('userData', path.join(app.getPath('appData'), 'Downloader'));

const ROOT_DIR = path.join(__dirname, '..');
const ICON_PATH = path.join(__dirname, 'icon.ico');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const PRESETS = ['mp4', 'mp3', 'wav'];

let mainWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
// Autostart passes --hidden so the app waits in the tray; the console commands pass --preset=mp3 or --preset=mp4.
let startHidden = process.argv.includes('--hidden');
let pendingPreset = parsePreset(process.argv);

function parsePreset(argv) {
  const value = argv.find((arg) => arg.startsWith('--preset='))?.slice('--preset='.length);
  return PRESETS.includes(value) ? value : null;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Audio goes to Music\Downloader and video to Videos\Downloader until the user picks other folders.
function ensureSettings() {
  const settings = readSettings();
  const resolved = {
    audioDir: settings.audioDir || path.join(app.getPath('music'), 'Downloader'),
    videoDir: settings.videoDir || path.join(app.getPath('videos'), 'Downloader'),
  };

  if (resolved.audioDir !== settings.audioDir || resolved.videoDir !== settings.videoDir) {
    writeSettings({ ...settings, ...resolved });
  }

  return resolved;
}

// The server runs under Electron's bundled Node, so yt-dlp can use the same binary as its JS runtime.
function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(path.join(ROOT_DIR, 'server.js'), [], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOST: '127.0.0.1',
        PORT: '0',
        DOWNLOADER_DATA_DIR: app.getPath('userData'),
        DOWNLOADER_SETTINGS_FILE: SETTINGS_FILE,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });

    serverProcess.once('message', (message) => {
      if (message?.type === 'ready') {
        resolve(message.port);
      }
    });

    serverProcess.once('error', reject);
    serverProcess.once('exit', (code) => {
      serverProcess = null;
      reject(new Error(`The download server stopped (exit code ${code}).`));
    });
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: 'Downloader',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    show: !startHidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131417' : '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const appUrl = `http://127.0.0.1:${port}/`;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingPreset) {
      mainWindow.webContents.send('preset', pendingPreset);
      pendingPreset = null;
    }
  });

  // Closing only hides the window, so the app stays ready in the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(appUrl);
}

function showWindow(preset) {
  if (!mainWindow) {
    startHidden = false;
    pendingPreset = preset || pendingPreset;
    return;
  }

  if (preset) {
    if (mainWindow.webContents.isLoading()) {
      pendingPreset = preset;
    } else {
      mainWindow.webContents.send('preset', preset);
    }
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  // Windows refuses plain focus() for background apps; briefly going on top brings the window forward.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
}

async function updateTrayMenu() {
  const supported = system.isSupported();
  const autostart = supported && system.isAutostartEnabled();
  const commands = supported && await system.areCommandsEnabled();

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Downloader', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostart,
      enabled: supported,
      click: (item) => {
        system.setAutostart(item.checked);
        void updateTrayMenu();
      },
    },
    {
      label: 'Console commands (mp3, video)',
      type: 'checkbox',
      checked: commands,
      enabled: supported,
      click: async (item) => {
        try {
          await system.setCommands(item.checked);
        } catch (error) {
          dialog.showErrorBox('Downloader', `Could not update PATH: ${error.message}`);
        }
        void updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(ICON_PATH);
  tray.setToolTip('Downloader');
  tray.on('click', () => showWindow());
  void updateTrayMenu();
}

// The install script passes these flags so setup goes through the same code as the tray menu.
async function applySetupFlags() {
  if (!system.isSupported()) {
    return;
  }

  if (process.argv.includes('--enable-autostart')) {
    system.setAutostart(true);
  }

  if (process.argv.includes('--enable-commands') && !await system.areCommandsEnabled()) {
    await system.setCommands(true);
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', () => ensureSettings());

  ipcMain.handle('settings:choose-folder', async (_event, kind) => {
    const key = kind === 'video' ? 'videoDir' : 'audioDir';
    const settings = ensureSettings();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'video' ? 'Folder for videos (MP4)' : 'Folder for audio (MP3/WAV)',
      defaultPath: settings[key],
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return settings;
    }

    const updated = { ...readSettings(), ...settings, [key]: result.filePaths[0] };
    writeSettings(updated);
    return ensureSettings();
  });

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.handle('clipboard:read-url', async () => {
    // readText() returns a Promise in current Electron versions.
    const text = String(await clipboard.readText()).trim();
    return /^https?:\/\/\S+$/i.test(text) ? text : null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--hidden')) {
      showWindow(parsePreset(argv));
    }
  });

  app.whenReady().then(async () => {
    ensureSettings();
    registerIpc();
    await applySetupFlags().catch((error) => console.error(error));
    createTray();

    try {
      const port = await startServer();
      createWindow(port);
    } catch (error) {
      dialog.showErrorBox('Downloader', error.message);
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', stopServer);
}
