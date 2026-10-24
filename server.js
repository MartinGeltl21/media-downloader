const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;

const app = express();
const PORT = Number(process.env.PORT || 3210);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
// The desktop app keeps yt-dlp, cookies, and temporary downloads in its user data folder.
const DATA_DIR = process.env.DOWNLOADER_DATA_DIR?.trim() || ROOT_DIR;
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const DEFAULT_COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
const SETTINGS_FILE = process.env.DOWNLOADER_SETTINGS_FILE?.trim() || null;
const YT_DLP_JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`];
const DIRECT_MEDIA_EXTENSIONS = new Set(['.mp4', '.mp3', '.wav', '.m4a', '.webm', '.ogg', '.mov', '.avi']);
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
const YT_DLP_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const jobs = new Map();

let ytDlpState = {
  status: 'pending',
  version: null,
  error: null,
};

let ytDlpReadyPromise;
let ffmpegState = {
  executable: 'ffmpeg',
  directory: null,
  found: false,
};

function createYtDlp() {
  return new YTDlpWrap(YT_DLP_PATH);
}

function getYtDlpAuthentication() {
  const configuredCookiesFile = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (configuredCookiesFile) {
    return {
      args: ['--cookies', path.resolve(ROOT_DIR, configuredCookiesFile)],
      type: 'file',
    };
  }

  if (fs.existsSync(DEFAULT_COOKIES_PATH)) {
    return {
      args: ['--cookies', DEFAULT_COOKIES_PATH],
      type: 'file',
    };
  }

  const configuredBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim();
  if (configuredBrowser) {
    return {
      args: ['--cookies-from-browser', configuredBrowser],
      type: 'browser',
      browser: configuredBrowser.split(/[+:]/, 1)[0],
    };
  }

  return {
    args: [],
    type: 'none',
  };
}

function formatYtDlpError(error) {
  const normalizedMessage = error.message.replace(/\s+/g, ' ').trim();
  const lowerMessage = normalizedMessage.toLowerCase();
  const authentication = getYtDlpAuthentication();

  if (lowerMessage.includes('could not copy') && lowerMessage.includes('cookie database')) {
    const browserName = authentication.browser || 'browser';
    return `Could not read ${browserName} cookies while the browser is open. Close it completely and try again, or export authenticated cookies to cookies.txt in the project folder.`;
  }

  if (lowerMessage.includes('account authentication is required')) {
    if (authentication.type === 'none') {
      return 'Reddit requires an authenticated account for this post. Export your Reddit browser cookies to cookies.txt in the project folder, or set YT_DLP_COOKIES_FROM_BROWSER=chrome and restart the app.';
    }

    return 'Reddit rejected the configured cookies. Sign in to Reddit again and refresh cookies.txt, or use cookies from a signed-in browser.';
  }

  if (lowerMessage.includes('not a bot') || lowerMessage.includes('cookies-from-browser')) {
    return 'YouTube is blocking the request without browser cookies. Configure cookies.txt or YT_DLP_COOKIES_FROM_BROWSER and try again.';
  }

  if (lowerMessage.includes('this video is unavailable')) {
    return 'This YouTube video is currently unavailable.';
  }

  return normalizedMessage;
}

async function ensureDirectories() {
  await Promise.all([
    fsp.mkdir(DOWNLOADS_DIR, { recursive: true }),
    fsp.mkdir(BIN_DIR, { recursive: true }),
  ]);
}

// Apps started from the macOS Finder or a Linux desktop get a minimal PATH without Homebrew or Snap,
// so these folders are searched as well.
const EXTRA_BIN_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', '/opt/local/bin'];

function resolveCommandOnPath(command) {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const resolved = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) {
      return resolved;
    }
  } catch {
    // Not on PATH; fall through to the usual install folders.
  }

  return EXTRA_BIN_DIRS
    .map((directory) => path.join(directory, command))
    .find((candidate) => fs.existsSync(candidate)) || null;
}

function getFfmpegInstallHint() {
  if (process.platform === 'darwin') {
    return 'brew install ffmpeg';
  }

  if (process.platform === 'linux') {
    return 'sudo apt install ffmpeg';
  }

  return 'winget install Gyan.FFmpeg';
}

function resolveFfmpegState() {
  const configuredPath = process.env.FFMPEG_PATH?.trim();
  const resolvedFfmpeg = configuredPath
    ? (fs.existsSync(configuredPath) ? configuredPath : null)
    : resolveCommandOnPath('ffmpeg');
  const ffmpegExecutable = resolvedFfmpeg || 'ffmpeg';
  const ffprobeExecutable = configuredPath
    ? path.join(path.dirname(configuredPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : resolveCommandOnPath('ffprobe');

  ffmpegState = {
    executable: ffmpegExecutable,
    directory: ffprobeExecutable ? path.dirname(ffprobeExecutable) : path.dirname(ffmpegExecutable),
    found: Boolean(resolvedFfmpeg),
  };

  if (!ffmpegState.found) {
    console.warn('ffmpeg was not found. Install it and make sure it is on PATH, or set FFMPEG_PATH.');
  }
}

// Outdated yt-dlp builds are the most common cause of YouTube failures, so refresh weekly.
async function updateYtDlpIfStale(ytDlp) {
  try {
    const stats = await fsp.stat(YT_DLP_PATH);
    if (Date.now() - stats.mtimeMs < YT_DLP_UPDATE_INTERVAL_MS) {
      return;
    }

    await ytDlp.execPromise(['-U']);
    const now = new Date();
    await fsp.utimes(YT_DLP_PATH, now, now);
  } catch (error) {
    console.warn(`yt-dlp update failed: ${error.message}`);
  }
}

async function readSettings() {
  if (!SETTINGS_FILE) {
    return {};
  }

  try {
    return JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function getTargetDirectory(preset) {
  const settings = await readSettings();
  const directory = preset === 'mp4' ? settings.videoDir : settings.audioDir;
  return typeof directory === 'string' && directory.trim() ? directory.trim() : null;
}

async function getAvailablePath(directory, fileName) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  let candidate = path.join(directory, fileName);

  for (let index = 2; await fileExists(candidate); index += 1) {
    candidate = path.join(directory, `${baseName} (${index})${extension}`);
  }

  return candidate;
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    await fsp.copyFile(sourcePath, targetPath);
    await fsp.unlink(sourcePath);
  }
}

// Moves a finished file from the working folder into the folder configured for its format.
async function deliverOutput(job) {
  const sourcePath = path.join(DOWNLOADS_DIR, job.outputName);
  job.outputPath = sourcePath;

  const targetDirectory = await getTargetDirectory(job.preset);
  if (!targetDirectory || path.resolve(targetDirectory) === path.resolve(DOWNLOADS_DIR)) {
    return;
  }

  await fsp.mkdir(targetDirectory, { recursive: true });
  const targetPath = await getAvailablePath(targetDirectory, job.outputName);
  await moveFile(sourcePath, targetPath);
  job.outputPath = targetPath;
  job.outputName = path.basename(targetPath);
}

// The standalone builds need no Python, unlike the generic yt-dlp file for macOS and Linux.
function getYtDlpAssetName() {
  if (process.platform === 'win32') {
    return 'yt-dlp.exe';
  }

  if (process.platform === 'darwin') {
    return 'yt-dlp_macos';
  }

  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

async function downloadYtDlp() {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getYtDlpAssetName()}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status} ${response.statusText}).`);
  }

  const partialPath = `${YT_DLP_PATH}.download`;
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(partialPath);
    output.on('error', reject).on('finish', resolve);
    Readable.fromWeb(response.body).on('error', reject).pipe(output);
  });
  await fsp.chmod(partialPath, 0o755);
  await fsp.rename(partialPath, YT_DLP_PATH);
}

async function ensureYtDlpBinary() {
  if (!ytDlpReadyPromise) {
    ytDlpReadyPromise = (async () => {
      await ensureDirectories();

      if (!fs.existsSync(YT_DLP_PATH)) {
        await downloadYtDlp();
      }

      const ytDlp = createYtDlp();
      await updateYtDlpIfStale(ytDlp);
      const version = await ytDlp.getVersion();
      ytDlpState = {
        status: 'ready',
        version: version.trim(),
        error: null,
      };
      return ytDlp;
    })().catch((error) => {
      ytDlpState = {
        status: 'error',
        version: null,
        error: error.message,
      };
      ytDlpReadyPromise = undefined;
      throw error;
    });
  }

  return ytDlpReadyPromise;
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Paste a media URL first.');
  }

  try {
    return new URL(value.trim()).toString();
  } catch {
    throw new Error('That URL is not valid.');
  }
}

function getUnsupportedUrlMessage(url) {
  const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
  const pathname = url.pathname.toLowerCase();

  if (
    (hostname === 'youtube.com' || hostname === 'm.youtube.com') &&
    pathname === '/results'
  ) {
    return 'Please paste a direct YouTube video link, not a search page.';
  }

  if (
    (hostname === 'youtube.com' || hostname === 'm.youtube.com') &&
    (pathname.startsWith('/@') || pathname.startsWith('/channel/') || pathname.startsWith('/c/') || pathname.startsWith('/user/'))
  ) {
    return 'Please paste a direct YouTube video link, not a channel page.';
  }

  return null;
}

function isDirectMediaUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return DIRECT_MEDIA_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

function sanitizeFileName(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'download';
}

function inferTitleFromUrl(url) {
  const parsed = new URL(url);
  const rawName = decodeURIComponent(path.basename(parsed.pathname, path.extname(parsed.pathname)));
  return sanitizeFileName(rawName.replace(/[-_]+/g, ' '));
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'Unknown';
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainder].map((value, index) => String(value).padStart(index === 0 ? 1 : 2, '0')).join(':');
  }

  return [minutes, remainder].map((value, index) => String(value).padStart(index === 0 ? 1 : 2, '0')).join(':');
}

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
  job.lastActivityAtMs = Date.now();
}

function serializeInfo(info) {
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const thumbnail = info.thumbnail || thumbnails.at(-1)?.url || null;
  return {
    id: info.id || null,
    title: info.title || 'Untitled media',
    thumbnail,
    duration: info.duration || null,
    durationLabel: formatDuration(info.duration),
    uploader: info.uploader || info.channel || info.extractor_key || 'Unknown source',
    extractor: info.extractor_key || info.extractor || 'Web',
    webpageUrl: info.webpage_url || null,
    description: typeof info.description === 'string' ? info.description.slice(0, 220) : '',
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    url: job.url,
    preset: job.preset,
    status: job.status,
    title: job.title,
    percent: job.percent,
    totalSize: job.totalSize,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    outputName: job.outputName,
    outputPath: job.status === 'complete' ? job.outputPath : null,
    outputUrl: job.status === 'complete' && path.dirname(job.outputPath) === DOWNLOADS_DIR
      ? `/downloads/${encodeURIComponent(job.outputName)}`
      : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function listDownloads() {
  await ensureDirectories();
  const entries = await fsp.readdir(DOWNLOADS_DIR, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
      .map(async (entry) => {
        const filePath = path.join(DOWNLOADS_DIR, entry.name);
        const stats = await fsp.stat(filePath);
        return {
          name: entry.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          url: `/downloads/${encodeURIComponent(entry.name)}`,
        };
      })
  );

  files.sort((left, right) => new Date(right.modifiedAt) - new Date(left.modifiedAt));
  return files;
}

async function findNewestOutput(startMs) {
  const files = await listDownloads();
  return files.find((file) => new Date(file.modifiedAt).getTime() >= startMs - 2000) || null;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readReportedOutputPath(reportPath) {
  try {
    const content = await fsp.readFile(reportPath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function failJob(job, error) {
  job.status = 'error';
  job.error = formatYtDlpError(error);
  touchJob(job);
}

async function probeDirectMedia(url) {
  const parsed = new URL(url);
  const title = inferTitleFromUrl(url);
  return {
    id: null,
    title,
    thumbnail: null,
    duration: null,
    durationLabel: 'Direct file',
    uploader: parsed.hostname,
    extractor: 'Direct',
    webpageUrl: url,
    description: 'Direct media file',
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegState.executable, args, { windowsHide: true });
    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `ffmpeg exited with code ${code}.`));
    });
  });
}

async function resolveCompletedOutput(job, reportedPath) {
  if (reportedPath && await fileExists(reportedPath)) {
    return path.basename(reportedPath);
  }

  const files = await listDownloads();
  const startedAfterMs = job.startedAtMs - 2000;
  const finalExtension = `.${job.preset.toLowerCase()}`;
  const matchingFinal = files.find((file) => {
    const modifiedAtMs = new Date(file.modifiedAt).getTime();
    const lowerName = file.name.toLowerCase();
    return (
      modifiedAtMs >= startedAfterMs &&
      lowerName.endsWith(finalExtension) &&
      !/\.f\d+\./i.test(lowerName)
    );
  });

  if (matchingFinal) {
    return matchingFinal.name;
  }

  const intermediate = files.find((file) => {
    const modifiedAtMs = new Date(file.modifiedAt).getTime();
    return modifiedAtMs >= startedAfterMs;
  });

  if (intermediate) {
    if (job.preset === 'mp4') {
      throw new Error('The video was downloaded, but it was not merged correctly. ffmpeg or ffprobe was not resolved correctly.');
    }

    throw new Error('The audio was downloaded, but it was not converted correctly. ffmpeg or ffprobe was not resolved correctly.');
  }

  throw new Error('No final output file was found.');
}

async function downloadDirectMedia(job) {
  const sourceUrl = new URL(job.url);
  const sourceExtension = path.extname(sourceUrl.pathname).toLowerCase() || '.bin';
  const baseName = sanitizeFileName(job.title || inferTitleFromUrl(job.url));
  const tempInputPath = path.join(DOWNLOADS_DIR, `${baseName} [source]${sourceExtension}`);
  const finalOutputPath = path.join(DOWNLOADS_DIR, `${baseName} [direct].${job.preset}`);

  job.status = 'running';
  touchJob(job);

  const response = await fetch(job.url);
  if (!response.ok || !response.body) {
    throw new Error(`Source returned ${response.status} ${response.statusText}.`);
  }

  const totalBytes = Number(response.headers.get('content-length') || 0);
  const sourceStream = Readable.fromWeb(response.body);
  const outputStream = fs.createWriteStream(tempInputPath);
  let writtenBytes = 0;

  await new Promise((resolve, reject) => {
    sourceStream.on('data', (chunk) => {
      writtenBytes += chunk.length;
      if (totalBytes > 0) {
        job.percent = ((writtenBytes / totalBytes) * 100).toFixed(1);
        job.totalSize = `${Math.round(totalBytes / 1024)} KiB`;
      }
      job.speed = 'Receiving';
      job.eta = totalBytes > 0 ? 'Calculating' : null;
      touchJob(job);
    });

    sourceStream.on('error', reject);
    outputStream.on('error', reject);
    outputStream.on('finish', resolve);
    sourceStream.pipe(outputStream);
  });

  const sourceMatchesPreset =
    (job.preset === 'mp4' && sourceExtension === '.mp4') ||
    (job.preset === 'mp3' && sourceExtension === '.mp3') ||
    (job.preset === 'wav' && sourceExtension === '.wav');

  if (sourceMatchesPreset) {
    await fsp.rename(tempInputPath, finalOutputPath);
  } else {
    job.speed = 'Converting';
    job.eta = null;
    touchJob(job);

    const ffmpegArgs =
      job.preset === 'mp4'
        ? ['-y', '-i', tempInputPath, '-c:v', 'libx264', '-c:a', 'aac', finalOutputPath]
        : job.preset === 'mp3'
          ? ['-y', '-i', tempInputPath, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', finalOutputPath]
          : ['-y', '-i', tempInputPath, '-vn', finalOutputPath];

    await runFfmpeg(ffmpegArgs);
    await fsp.unlink(tempInputPath).catch(() => undefined);
  }

  job.outputName = path.basename(finalOutputPath);
  await deliverOutput(job);
  job.status = 'complete';
  job.percent = '100.0%';
  job.speed = 'Done';
  job.eta = '0s';
  touchJob(job);
}

async function runDownload(job) {
  if (isDirectMediaUrl(job.url)) {
    await downloadDirectMedia(job);
    return;
  }

  await ensureYtDlpBinary();
  const ytDlp = createYtDlp();
  const authentication = getYtDlpAuthentication();
  const controller = new AbortController();
  const outputReportPath = path.join(BIN_DIR, `${job.id}.output.txt`);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--socket-timeout',
    '15',
    '--extractor-retries',
    '1',
    '--retries',
    '2',
    ...YT_DLP_JS_RUNTIME_ARGS,
    ...authentication.args,
    '--windows-filenames',
    '--ffmpeg-location',
    ffmpegState.directory || ffmpegState.executable,
    '-P',
    DOWNLOADS_DIR,
    '-o',
    '%(title).180B [%(id)s].%(ext)s',
    '--print-to-file',
    'after_move:filepath',
    outputReportPath,
  ];

  if (job.preset === 'mp4') {
    args.push(
      '-f',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      '--merge-output-format',
      'mp4'
    );
  } else {
    args.push(
      '-x',
      '--audio-format',
      job.preset,
      '--audio-quality',
      '0'
    );
  }

  args.push(job.url);

  job.status = 'running';
  touchJob(job);

  const emitter = ytDlp.exec(args, { windowsHide: true }, controller.signal);
  let timedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - job.lastActivityAtMs > DOWNLOAD_IDLE_TIMEOUT_MS) {
      timedOut = true;
      controller.abort();
    }
  }, 5000);

  emitter.on('progress', (progress) => {
    job.percent = progress.percent ?? null;
    job.totalSize = progress.totalSize ?? null;
    job.speed = progress.currentSpeed ?? null;
    job.eta = progress.eta ?? null;
    touchJob(job);
  });

  emitter.on('ytDlpEvent', (eventType, eventData) => {
    const cleanedEventData = eventData.trim();
    if (eventType === 'download' && cleanedEventData.startsWith('Destination: ')) {
      const outputPath = cleanedEventData.replace('Destination: ', '').trim();
      job.outputName = path.basename(outputPath);
    }

    touchJob(job);
  });

  return new Promise((resolve, reject) => {
    emitter.on('error', (error) => {
      clearInterval(watchdog);
      void fsp.unlink(outputReportPath).catch(() => undefined);
      failJob(job, error);
      reject(error);
    });

    emitter.on('close', async (code) => {
      clearInterval(watchdog);
      try {
        if (timedOut) {
          throw new Error('The source stopped responding. Try a different URL or try again.');
        }

        if (code !== 0) {
          throw new Error(`yt-dlp exited with code ${code}.`);
        }

        const reportedPath = await readReportedOutputPath(outputReportPath);
        const outputName = await resolveCompletedOutput(job, reportedPath);
        job.outputName = outputName;
        await deliverOutput(job);
        job.status = 'complete';
        job.percent = '100.0%';
        job.eta = '0s';
        touchJob(job);
        resolve();
      } catch (error) {
        failJob(job, error);
        reject(error);
      } finally {
        await fsp.unlink(outputReportPath).catch(() => undefined);
      }
    });
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/downloads', express.static(DOWNLOADS_DIR, { fallthrough: false }));

app.get('/api/health', async (_request, response) => {
  try {
    await ensureYtDlpBinary();
  } catch {
    // health reports state below
  }

  response.json({
    engine: ytDlpState,
    ffmpegPath: ffmpegState.executable,
    ffmpegFound: ffmpegState.found,
    ffmpegInstallHint: getFfmpegInstallHint(),
  });
});

app.get('/api/files', async (_request, response) => {
  const files = await listDownloads();
  response.json({ files });
});

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: 'Job not found.' });
    return;
  }

  response.json({ job: serializeJob(job) });
});

app.post('/api/probe', async (request, response) => {
  try {
    const url = parseUrl(request.body?.url);
    const unsupportedUrlMessage = getUnsupportedUrlMessage(new URL(url));
    if (unsupportedUrlMessage) {
      throw new Error(unsupportedUrlMessage);
    }

    if (isDirectMediaUrl(url)) {
      response.json({ info: await probeDirectMedia(url) });
      return;
    }

    await ensureYtDlpBinary();
    const ytDlp = createYtDlp();
    const authentication = getYtDlpAuthentication();
    const info = await ytDlp.getVideoInfo([
      url,
      '--no-warnings',
      '--no-playlist',
      '-f',
      'bv*+ba/b',
      ...YT_DLP_JS_RUNTIME_ARGS,
      ...authentication.args,
    ]);

    response.json({ info: serializeInfo(info) });
  } catch (error) {
    response.status(400).json({ error: formatYtDlpError(error) });
  }
});

app.post('/api/download', async (request, response) => {
  try {
    const url = parseUrl(request.body?.url);
    const unsupportedUrlMessage = getUnsupportedUrlMessage(new URL(url));
    if (unsupportedUrlMessage) {
      throw new Error(unsupportedUrlMessage);
    }

    const preset = request.body?.preset;
    if (!['mp4', 'mp3', 'wav'].includes(preset)) {
      throw new Error('Choose MP4, MP3, or WAV.');
    }

    const requestedTitle = typeof request.body?.title === 'string'
      ? request.body.title.trim()
      : '';
    const title = requestedTitle || (isDirectMediaUrl(url) ? inferTitleFromUrl(url) : 'Download');

    const job = {
      id: crypto.randomUUID(),
      url,
      preset,
      title,
      status: 'queued',
      percent: null,
      totalSize: null,
      speed: null,
      eta: null,
      error: null,
      outputName: null,
      outputPath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
    };

    jobs.set(job.id, job);
    void runDownload(job).catch(() => undefined);

    response.status(202).json({ job: serializeJob(job) });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

resolveFfmpegState();
ensureYtDlpBinary().catch(() => undefined);

const server = app.listen(PORT, process.env.HOST || undefined, () => {
  const { port } = server.address();
  console.log(`Downloader running at http://localhost:${port}`);
  // Started by the desktop app: report the chosen port back to it.
  process.send?.({ type: 'ready', port });
});

// Exit together with the desktop app, even if it was killed without a clean shutdown.
process.on('disconnect', () => process.exit(0));
