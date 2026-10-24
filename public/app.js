const desktopApi = window.desktop || null;

const state = {
  preset: 'mp4',
  currentInfo: null,
  currentJobId: null,
  pollTimer: null,
  settings: null,
  outputPath: null,
};

const elements = {
  form: document.querySelector('#download-form'),
  urlInput: document.querySelector('#url-input'),
  previewButton: document.querySelector('#preview-button'),
  presetButtons: Array.from(document.querySelectorAll('.preset-button')),
  status: document.querySelector('#status'),
  jobStatus: document.querySelector('#job-status'),
  progressBar: document.querySelector('#progress-bar'),
  metricProgress: document.querySelector('#metric-progress'),
  metricSpeed: document.querySelector('#metric-speed'),
  metricSize: document.querySelector('#metric-size'),
  metricEta: document.querySelector('#metric-eta'),
  metaTitle: document.querySelector('#meta-title'),
  metaText: document.querySelector('#meta-text'),
  resultLink: document.querySelector('#result-link'),
  folders: document.querySelector('#folders'),
  folderButtons: Array.from(document.querySelectorAll('.folder-button')),
  resultActions: document.querySelector('#result-actions'),
  resultName: document.querySelector('#result-name'),
  resultShow: document.querySelector('#result-show'),
};

function getFolderKind(preset) {
  return preset === 'mp4' ? 'video' : 'audio';
}

function getFolder(kind) {
  return kind === 'video' ? state.settings.videoDir : state.settings.audioDir;
}

// Two small folder icons; the tooltip shows the path and the selected format's icon is highlighted.
function renderTarget() {
  if (!state.settings) {
    return;
  }

  const activeKind = getFolderKind(state.preset);
  elements.folderButtons.forEach((button) => {
    const label = button.dataset.kind === 'video' ? 'MP4 folder' : 'MP3 / WAV folder';
    const folder = getFolder(button.dataset.kind);
    button.title = `${label}: ${folder}\nClick to change`;
    button.setAttribute('aria-label', `Change ${label} (${folder})`);
    button.classList.toggle('active', button.dataset.kind === activeKind);
  });
}

function getUnsupportedUrlMessage(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = url.pathname.toLowerCase();

    if ((hostname === 'youtube.com' || hostname === 'm.youtube.com') && pathname === '/results') {
      return 'Please paste a direct YouTube video link, not a search page.';
    }

    if (
      (hostname === 'youtube.com' || hostname === 'm.youtube.com') &&
      (pathname.startsWith('/@') || pathname.startsWith('/channel/') || pathname.startsWith('/c/') || pathname.startsWith('/user/'))
    ) {
      return 'Please paste a direct YouTube video link, not a channel page.';
    }
  } catch {
    return null;
  }

  return null;
}

function setPreset(preset) {
  state.preset = preset;
  elements.presetButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.preset === preset);
  });
  renderTarget();
}

// state is one of idle, busy, success, or error and drives the status colors.
function setJobStatus(message, state = 'idle') {
  elements.jobStatus.textContent = message;
  elements.status.dataset.state = state;
}

function setProgress(percentText) {
  const numeric = Number.parseFloat(percentText);
  const width = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
  elements.progressBar.style.width = `${width}%`;
  elements.metricProgress.textContent = Number.isFinite(numeric) ? `${width.toFixed(1)}%` : '0%';
}

function resetResultLink() {
  elements.resultLink.classList.add('hidden');
  elements.resultLink.removeAttribute('href');
  elements.resultActions.classList.add('hidden');
  state.outputPath = null;
}

function showResult(job) {
  if (desktopApi && job.outputPath) {
    state.outputPath = job.outputPath;
    elements.resultName.textContent = job.outputName;
    elements.resultActions.classList.remove('hidden');
    return;
  }

  if (job.outputUrl) {
    showResultLink(job.outputUrl, job.outputName || 'Open file');
  }
}

function showResultLink(url, label) {
  elements.resultLink.href = url;
  elements.resultLink.textContent = label;
  elements.resultLink.classList.remove('hidden');
}

function renderPreview(info) {
  state.currentInfo = info;
  elements.metaTitle.textContent = info.title || 'Preview ready';
  elements.metaText.textContent = `${info.uploader || '-'} | ${info.durationLabel || '-'} | ${info.extractor || '-'}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }
  return payload;
}

async function previewUrl() {
  const url = elements.urlInput.value.trim();
  if (!url) {
    setJobStatus('Please paste a link.', 'error');
    return;
  }

  const unsupportedUrlMessage = getUnsupportedUrlMessage(url);
  if (unsupportedUrlMessage) {
    setJobStatus(unsupportedUrlMessage, 'error');
    return;
  }

  setJobStatus('Loading preview...', 'busy');
  try {
    const payload = await fetchJson('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    renderPreview(payload.info);
    setJobStatus('Preview ready.');
  } catch (error) {
    setJobStatus(error.message, 'error');
  }
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollJob() {
  if (!state.currentJobId) {
    return;
  }

  try {
    const payload = await fetchJson(`/api/jobs/${state.currentJobId}`);
    const job = payload.job;

    setProgress(job.percent || '0');
    elements.metricSpeed.textContent = job.speed || '-';
    elements.metricSize.textContent = job.totalSize || '-';
    elements.metricEta.textContent = job.eta || '-';

    if (job.status === 'queued') {
      setJobStatus('Queued...', 'busy');
      return;
    }

    if (job.status === 'running') {
      setJobStatus('Running...', 'busy');
      return;
    }

    if (job.status === 'complete') {
      setJobStatus('Done.', 'success');
      showResult(job);
      stopPolling();
      return;
    }

    if (job.status === 'error') {
      setJobStatus(job.error || 'Download failed.', 'error');
      stopPolling();
    }
  } catch (error) {
    setJobStatus(error.message, 'error');
    stopPolling();
  }
}

async function startDownload(event) {
  event.preventDefault();
  resetResultLink();

  const url = elements.urlInput.value.trim();
  if (!url) {
    setJobStatus('Please paste a link.', 'error');
    return;
  }

  const unsupportedUrlMessage = getUnsupportedUrlMessage(url);
  if (unsupportedUrlMessage) {
    setJobStatus(unsupportedUrlMessage, 'error');
    return;
  }

  setJobStatus('Starting download...', 'busy');
  setProgress('0');
  elements.metricSpeed.textContent = '-';
  elements.metricSize.textContent = '-';
  elements.metricEta.textContent = '-';

  try {
    const payload = await fetchJson('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        preset: state.preset,
        title: state.currentInfo?.title || '',
      }),
    });

    state.currentJobId = payload.job.id;
    stopPolling();
    state.pollTimer = window.setInterval(pollJob, 1000);
    await pollJob();
  } catch (error) {
    setJobStatus(error.message, 'error');
  }
}

elements.presetButtons.forEach((button) => {
  button.addEventListener('click', () => setPreset(button.dataset.preset));
});

elements.previewButton.addEventListener('click', previewUrl);
elements.form.addEventListener('submit', startDownload);

// Without ffmpeg, MP3/WAV conversion and MP4 merging fail, so say so up front.
async function checkFfmpeg() {
  try {
    const health = await fetchJson('/api/health');
    if (health.ffmpegFound === false) {
      setJobStatus('ffmpeg is missing. Install it (winget install Gyan.FFmpeg) and restart the app.', 'error');
    }
  } catch {
    // The status line already reports request errors when the user starts a download.
  }
}

void checkFfmpeg();

// Desktop app only: per-format folders, file actions, and pasting a copied link on focus.
// On focus only an empty field is filled; opening via the mp3/video command replaces an older link.
async function pasteClipboardUrl(replace = false) {
  const currentUrl = elements.urlInput.value.trim();
  if (currentUrl && !replace) {
    return;
  }

  const url = await desktopApi.readClipboardUrl();
  if (url && url !== currentUrl && !getUnsupportedUrlMessage(url)) {
    elements.urlInput.value = url;
    state.currentInfo = null;
    resetResultLink();
  }
}

async function initDesktop() {
  state.settings = await desktopApi.getSettings();
  elements.folders.classList.remove('hidden');
  renderTarget();

  elements.folderButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      state.settings = await desktopApi.chooseFolder(button.dataset.kind);
      renderTarget();
    });
  });

  elements.resultShow.addEventListener('click', () => {
    if (state.outputPath) {
      void desktopApi.showItem(state.outputPath);
    }
  });

  elements.urlInput.addEventListener('input', () => {
    state.currentInfo = null;
  });

  window.addEventListener('focus', pasteClipboardUrl);
  await pasteClipboardUrl();
  elements.urlInput.focus();
}

if (desktopApi) {
  desktopApi.onPreset((preset) => {
    setPreset(preset);
    void pasteClipboardUrl(true);
    elements.urlInput.focus();
  });
  void initDesktop();
}
