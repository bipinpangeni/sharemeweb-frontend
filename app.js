/**
 * app.js — ShareMeWeb v2
 */

'use strict';

const SIGNALING_URL = (() => {
  const meta = document.querySelector('meta[name="signaling-url"]');
  return meta ? meta.content : 'http://localhost:3001';
})();

function keepServerAwake() {
  fetch(SIGNALING_URL + '/health', { method: 'GET', mode: 'no-cors' }).catch(() => {});
}
keepServerAwake();
// Ping every 4 minutes to prevent Render from sleeping (sleeps at 15 mins)
setInterval(keepServerAwake, 4 * 60 * 1000);

const $ = (sel) => document.querySelector(sel);

const UI = {
  tabSend: $('#tab-send'), tabReceive: $('#tab-receive'),
  panelSend: $('#panel-send'), panelReceive: $('#panel-receive'),
  uploadZone: $('#upload-zone'), fileInput: $('#file-input'),
  fileInfoStrip: $('#file-info-strip'), fileIcon: $('#file-icon'),
  fileName: $('#file-name'), fileSize: $('#file-size'),
  btnClear: $('#btn-clear'), btnGenerate: $('#btn-generate'),
  qrSection: $('#qr-section'), qrContainer: $('#qr-container'),
  sessionLinkSpan: $('#session-link'), btnCopy: $('#btn-copy'),
  statusSend: $('#status-send'), peerList: $('#peer-list'), peerCount: $('#peer-count'),
  btnScanQR: $('#btn-scan-qr'), btnShowMyQR: $('#btn-show-my-qr'),
  myQRSection: $('#my-qr-section'), myQRContainer: $('#my-qr-container'),
  mySessionLink: $('#my-session-link'), btnCopyMyLink: $('#btn-copy-my-link'),
  cameraView: $('#camera-view'), cameraVideo: $('#camera-video'),
  btnCameraStop: $('#btn-camera-stop'), linkInput: $('#link-input'),
  btnConnect: $('#btn-connect'), statusReceive: $('#status-receive'),
  incomingFile: $('#incoming-file'), incomingName: $('#incoming-name'),
  incomingSize: $('#incoming-size'), progressReceive: $('#progress-receive'),
  progressBarR: $('#progress-bar-receive'), progressPctR: $('#progress-pct-receive'),
  progressSpeedR: $('#progress-speed-r'), progressETAR: $('#progress-eta-r'),
  btnDownload: $('#btn-download'), hamburger: $('#hamburger'), navLinks: $('#nav-links'),
};

let selectedFile   = null;
let selectedFiles  = [];
let currentFileIndex = 0;
let multiSender    = null;
let rtcReceive     = null;
let socket         = null;
let sessionId      = null;
let downloadBlob_  = null;
let downloadName_  = '';
let scanner        = null;
let sessionMode    = 'sender-first';
const offCanvas    = document.createElement('canvas');

document.addEventListener('DOMContentLoaded', () => {
  initNav(); initTabs(); initUploadZone(); checkURLForSession(); initContactForm();
});

function initNav() {
  if (!UI.hamburger) return;
  UI.hamburger.addEventListener('click', () => UI.navLinks.classList.toggle('open'));
}

function initTabs() {
  if (!UI.tabSend) return;
  UI.tabSend.addEventListener('click',    () => switchTab('send'));
  UI.tabReceive.addEventListener('click', () => switchTab('receive'));
}

function switchTab(tab) {
  const s = tab === 'send';
  UI.tabSend.classList.toggle('active', s);
  UI.tabReceive.classList.toggle('active', !s);
  UI.panelSend.classList.toggle('active', s);
  UI.panelReceive.classList.toggle('active', !s);
}

function checkURLForSession() {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get('s');
  const mode = params.get('mode');
  if (sid && UI.linkInput) {
    UI.linkInput.value = window.location.href;
    switchTab('receive');
    if (mode === 'rf') setTimeout(() => connectAsSender(window.location.href), 400);
    else               setTimeout(() => connectToSession(window.location.href), 400);
  }
}

function initUploadZone() {
  if (!UI.uploadZone) return;
  UI.uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); UI.uploadZone.classList.add('dragover'); });
  UI.uploadZone.addEventListener('dragleave', () => UI.uploadZone.classList.remove('dragover'));
  UI.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault(); UI.uploadZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFilesSelected(files);
  });
  UI.fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || UI.fileInput.files || []);
    if (files.length > 0) handleFilesSelected(files);
  });
  UI.btnClear.addEventListener('click', clearFile);
  UI.btnGenerate.addEventListener('click', startSenderSession);
  UI.btnCopy.addEventListener('click', copySessionLink);
  if (UI.btnScanQR)     UI.btnScanQR.addEventListener('click', startCameraScanner);
  if (UI.btnCameraStop) UI.btnCameraStop.addEventListener('click', stopCameraScanner);
  if (UI.btnConnect)    UI.btnConnect.addEventListener('click', () => connectToSession(UI.linkInput.value.trim()));
  if (UI.btnDownload)   UI.btnDownload.addEventListener('click', triggerDownload);
  if (UI.btnShowMyQR)   UI.btnShowMyQR.addEventListener('click', startReceiverFirstSession);
  if (UI.btnCopyMyLink) UI.btnCopyMyLink.addEventListener('click', copyMyLink);
}

/* ── Safe wrappers ───────────────────────────────────────────── */
function safeFormatSize(bytes) {
  if (typeof formatSize === 'function') return formatSize(bytes);
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function safeFileEmoji(name) {
  if (typeof fileEmoji === 'function') return fileEmoji(name);
  return '📁';
}
function safeFormatSpeed(bps) {
  if (typeof formatSpeed === 'function') return formatSpeed(bps);
  return safeFormatSize(bps) + '/s';
}
function safeFormatETA(remaining, speed) {
  if (typeof formatETA === 'function') return formatETA(remaining, speed);
  if (!speed) return '—';
  const s = Math.ceil(remaining / speed);
  return s < 60 ? s + 's' : Math.ceil(s/60) + 'm';
}
async function safeGenerateQR(text, container, size) {
  if (typeof generateQR === 'function') return generateQR(text, container, size);
  container.innerHTML = '<p style="font-size:.7rem;word-break:break-all;padding:8px;">' + text + '</p>';
}
function safeDownloadBlob(blob, name) {
  if (typeof downloadBlob === 'function') return downloadBlob(blob, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ── Multiple files — sent ONE BY ONE, no zipping ───────────── */
async function handleFilesSelected(files) {
  if (!files || files.length === 0) return;

  selectedFiles    = Array.from(files);
  currentFileIndex = 0;
  selectedFile     = selectedFiles[0];

  if (files.length === 1) {
    UI.fileIcon.textContent = safeFileEmoji(files[0].name);
    UI.fileName.textContent = files[0].name;
    UI.fileSize.textContent = safeFormatSize(files[0].size);
  } else {
    const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);
    UI.fileIcon.textContent = '📂';
    UI.fileName.textContent = files.length + ' files selected';
    UI.fileSize.textContent = safeFormatSize(totalSize) + ' total';
    renderFileList(selectedFiles);
  }

  UI.fileInfoStrip.classList.add('visible');
  UI.btnGenerate.disabled = false;
  UI.qrSection.classList.remove('visible');
  setStatus(UI.statusSend, '', '');
  resetPeerList();
}

function renderFileList(files) {
  const list = $('#selected-files-list');
  if (!list) return;
  list.innerHTML = '';
  list.style.display = 'block';
  Array.from(files).forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-list-item';
    item.id = 'file-list-item-' + i;
    item.innerHTML = `
      <span style="display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
        <span id="file-status-${i}">${i === 0 ? '📤' : '⏳'}</span>
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeFileEmoji(f.name)} ${f.name}</span>
      </span>
      <span class="file-list-size">${safeFormatSize(f.size)}</span>`;
    list.appendChild(item);
  });
}

function updateFileListStatus(index, status) {
  const el   = $('#file-status-' + index);
  const item = $('#file-list-item-' + index);
  if (!el) return;
  const icons = { sending: '📤', done: '✅', waiting: '⏳' };
  el.textContent = icons[status] || status;
  if (item && status === 'done')    item.style.opacity = '0.6';
  if (item && status === 'sending') item.style.background = 'var(--accent-light)';
}

function clearFile() {
  selectedFile = null; selectedFiles = []; currentFileIndex = 0;
  UI.fileInput.value = '';
  UI.fileInfoStrip.classList.remove('visible');
  UI.btnGenerate.disabled = true;
  UI.qrSection.classList.remove('visible');
  setStatus(UI.statusSend, '', '');
  resetPeerList();
  const list = $('#selected-files-list');
  if (list) { list.innerHTML = ''; list.style.display = 'none'; }
  if (multiSender) { multiSender.destroyAll(); multiSender = null; }
  if (socket)      { socket.disconnect(); socket = null; }
}

/* ── SENDER FLOW ─────────────────────────────────────────────── */
async function startSenderSession() {
  if (!selectedFile) return;
  sessionMode = 'sender-first';
  UI.btnGenerate.disabled = true;
  UI.btnGenerate.innerHTML = '<span class="spinner"></span> Connecting…';
  setStatus(UI.statusSend, '⚡ Waking up server…', 'waiting');

  try {
    socket    = connectSignaling();
    sessionId = generateId();
    setStatus(UI.statusSend, '🔗 Connecting to server…', 'waiting');
    await waitFor(socket, 'connect', 4000);
    setStatus(UI.statusSend, '✓ Server connected — generating QR…', 'connect');
    socket.emit('create-session', { sessionId, mode: 'sender-first' });

    multiSender = new MultiSender(selectedFile, {
      onPeerProgress: (pid, pct, bytes, speed, total) => updatePeerProgress(pid, pct, bytes, speed, total),
      onPeerComplete: (pid) => {
        markPeerDone(pid);
        updateFileListStatus(currentFileIndex, 'done');
        currentFileIndex++;
        if (currentFileIndex < selectedFiles.length) {
          const nextFile = selectedFiles[currentFileIndex];
          selectedFile = nextFile;
          multiSender._file = nextFile;
          multiSender._peers.forEach(peer => { peer._file = nextFile; peer._offset = 0; });
          UI.fileIcon.textContent = safeFileEmoji(nextFile.name);
          UI.fileName.textContent = '(' + (currentFileIndex+1) + '/' + selectedFiles.length + ') ' + nextFile.name;
          UI.fileSize.textContent = safeFormatSize(nextFile.size);
          updateFileListStatus(currentFileIndex, 'sending');
          setStatus(UI.statusSend, '📤 Sending file ' + (currentFileIndex+1) + ' of ' + selectedFiles.length + '…', 'transfer');
        } else if (selectedFiles.length > 1) {
          setStatus(UI.statusSend, '✅ All ' + selectedFiles.length + ' files sent!', 'done');
        }
      },
      onPeerStatus:   (pid, msg, type) => updatePeerStatus(pid, msg, type),
      onIceCandidate: (pid, cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'sender', peerId: pid }),
    });

    const sessionURL = `${window.location.origin}/?s=${sessionId}`;
    UI.qrSection.classList.add('visible');
    await safeGenerateQR(sessionURL, UI.qrContainer, 200);
    UI.sessionLinkSpan.textContent = sessionURL;
    setStatus(UI.statusSend, 'Session ready — waiting for receivers…', 'waiting');

    socket.on('peer-joined', async ({ peerId }) => {
      const peerRtc = multiSender.addPeer(peerId);
      addPeerCard(peerId);
      const offer = await peerRtc.createOffer();
      socket.emit('offer', { sessionId, sdp: offer, peerId });
      updatePeerStatus(peerId, 'Offer sent…', 'waiting');
    });
    socket.on('answer', async ({ sdp, peerId }) => {
      const peerRtc = multiSender.getPeer(peerId);
      if (peerRtc) await peerRtc.handleAnswer(sdp);
    });
    socket.on('ice-candidate', async ({ candidate, role, peerId }) => {
      if (role === 'receiver') {
        const peerRtc = multiSender.getPeer(peerId);
        if (peerRtc) await peerRtc.addIceCandidate(candidate);
      }
    });
    socket.on('peer-left', ({ peerId }) => markPeerLeft(peerId));
    socket.on('error', (msg) => setStatus(UI.statusSend, 'Error: ' + msg, 'error'));

  } catch (err) {
    setStatus(UI.statusSend, 'Failed: ' + err.message, 'error');
  } finally {
    UI.btnGenerate.disabled = false;
    UI.btnGenerate.textContent = '🔄 Regenerate';
  }
}

/* ── RECEIVER-FIRST FLOW ─────────────────────────────────────── */
async function startReceiverFirstSession() {
  sessionMode = 'receiver-first';
  UI.btnShowMyQR.disabled = true;
  UI.btnShowMyQR.innerHTML = '<span class="spinner"></span> Generating…';
  try {
    socket = connectSignaling(); sessionId = generateId();
    await waitFor(socket, 'connect', 6000);
    socket.emit('create-session', { sessionId, mode: 'receiver-first' });
    rtcReceive = new ShareDropRTC({
      onProgress: updateReceiveProgress, onComplete: handleFileComplete,
      onStatus: (msg, type) => setStatus(UI.statusReceive, msg, type),
      onFileInfo: showIncomingFile,
      onIceCandidate: (cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'receiver' }),
    });
    const offer = await rtcReceive.createReceiverOffer();
    socket.emit('offer', { sessionId, sdp: offer });
    const sessionURL = `${window.location.origin}/?s=${sessionId}&mode=rf`;
    UI.myQRSection.style.display = 'block';
    UI.myQRSection.classList.add('visible');
    await safeGenerateQR(sessionURL, UI.myQRContainer, 200);
    UI.mySessionLink.textContent = sessionURL;
    setStatus(UI.statusReceive, 'Show this QR to the sender — waiting…', 'waiting');
    socket.on('answer', async ({ sdp }) => { await rtcReceive.handleSenderAnswer(sdp); });
    socket.on('ice-candidate', async ({ candidate, role }) => { if (role === 'sender') await rtcReceive.addIceCandidate(candidate); });
    socket.on('error', (msg) => setStatus(UI.statusReceive, 'Error: ' + msg, 'error'));
  } catch (err) {
    setStatus(UI.statusReceive, 'Failed: ' + err.message, 'error');
  } finally {
    UI.btnShowMyQR.disabled = false;
    UI.btnShowMyQR.textContent = '📱 Show My QR Code';
  }
}

async function connectAsSender(rawLink) {
  let sid;
  try { sid = new URL(rawLink).searchParams.get('s'); } catch(_) { sid = rawLink.trim(); }
  if (!sid) { setStatus(UI.statusReceive, 'Invalid link.', 'error'); return; }
  switchTab('send');
  setStatus(UI.statusSend, '📱 Receiver QR scanned! Now select a file to send.', 'waiting');
  window._pendingReceiverSession = sid;
  const origHandler = UI.btnGenerate.onclick;
  UI.btnGenerate.onclick = async () => {
    if (!selectedFile) return;
    await sendToReceiverFirst(window._pendingReceiverSession);
    UI.btnGenerate.onclick = origHandler;
    window._pendingReceiverSession = null;
  };
}

async function sendToReceiverFirst(sid) {
  sessionId = sid; sessionMode = 'receiver-first';
  UI.btnGenerate.disabled = true;
  UI.btnGenerate.innerHTML = '<span class="spinner"></span> Connecting…';
  try {
    socket = connectSignaling();
    await waitFor(socket, 'connect', 6000);
    socket.emit('join-session', { sessionId, role: 'sender' });
    socket.on('offer', async ({ sdp }) => {
      const rtcSend = new ShareDropRTC({
        onProgress: (pct, bytes, speed, total) => updateSendProgress('single', pct, bytes, speed, total),
        onComplete: () => setStatus(UI.statusSend, '✓ File sent!', 'done'),
        onStatus:   (msg, type) => setStatus(UI.statusSend, msg, type),
        onIceCandidate: (cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'sender' }),
      });
      rtcSend.setFile(selectedFile);
      const answer = await rtcSend.answerReceiverOffer(sdp);
      socket.emit('answer', { sessionId, sdp: answer });
    });
  } catch (err) {
    setStatus(UI.statusSend, 'Failed: ' + err.message, 'error');
  } finally {
    UI.btnGenerate.disabled = false;
    UI.btnGenerate.textContent = 'Generate QR Code & Share Link →';
  }
}

/* ── RECEIVER FLOW ───────────────────────────────────────────── */
function connectToSession(rawLink) {
  let sid;
  try { sid = new URL(rawLink).searchParams.get('s'); } catch(_) { sid = rawLink.trim(); }
  if (!sid) { setStatus(UI.statusReceive, 'Invalid link.', 'error'); return; }
  sessionId = sid;
  const peerId = generateId();
  setStatus(UI.statusReceive, '⚡ Waking up server…', 'waiting');
  socket = connectSignaling();
  socket.on('connect', () => {
    setStatus(UI.statusReceive, '🔗 Joining session…', 'waiting');
    socket.emit('join-session', { sessionId, peerId });
  });
  socket.on('offer', async ({ sdp }) => {
    rtcReceive = new ShareDropRTC({
      onProgress: updateReceiveProgress, onComplete: handleFileComplete,
      onStatus: (msg, type) => setStatus(UI.statusReceive, msg, type),
      onFileInfo: showIncomingFile,
      onIceCandidate: (cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'receiver', peerId }),
    });
    const answer = await rtcReceive.createAnswer(sdp);
    socket.emit('answer', { sessionId, sdp: answer, peerId });
  });
  socket.on('ice-candidate', async ({ candidate, role }) => {
    if (role === 'sender' && rtcReceive) await rtcReceive.addIceCandidate(candidate);
  });
  socket.on('session-not-found', () => setStatus(UI.statusReceive, 'Session not found or expired.', 'error'));
  socket.on('connect_error', () => setStatus(UI.statusReceive, 'Cannot reach server.', 'error'));
}

/* ── PEER LIST ───────────────────────────────────────────────── */
function addPeerCard(peerId) {
  if (!UI.peerList) return;
  UI.peerList.classList.add('visible');
  const card = document.createElement('div');
  card.className = 'peer-card fade-in'; card.id = 'peer-' + peerId;
  card.innerHTML = `
    <div class="peer-card-header">
      <span class="peer-icon">📱</span>
      <span class="peer-name">Receiver #${UI.peerList.children.length + 1}</span>
      <span class="peer-status-badge" id="pbadge-${peerId}">Connecting…</span>
    </div>
    <div class="progress-bar-bg" style="margin-top:8px;">
      <div class="progress-bar-fill" id="pbar-${peerId}" style="width:0%"></div>
    </div>
    <div class="peer-stats">
      <span id="ppct-${peerId}">0%</span>
      <span id="pspeed-${peerId}">—</span>
      <span id="peta-${peerId}">—</span>
    </div>`;
  UI.peerList.appendChild(card);
  const count = UI.peerList.children.length;
  if (UI.peerCount) UI.peerCount.textContent = count + ' receiver' + (count > 1 ? 's' : '') + ' connected';
}

function updatePeerProgress(peerId, pct, bytes, speed, total) {
  const bar = document.getElementById('pbar-' + peerId);
  const pct_ = document.getElementById('ppct-' + peerId);
  const spd = document.getElementById('pspeed-' + peerId);
  const eta = document.getElementById('peta-' + peerId);
  const badge = document.getElementById('pbadge-' + peerId);
  if (bar)   bar.style.width   = pct + '%';
  if (pct_)  pct_.textContent  = pct + '%';
  if (spd)   spd.textContent   = safeFormatSpeed(speed);
  if (eta)   eta.textContent   = safeFormatETA(total - bytes, speed);
  if (badge) { badge.textContent = 'Transferring…'; badge.className = 'peer-status-badge badge-transfer'; }
}

function updatePeerStatus(peerId, msg, type) {
  const badge = document.getElementById('pbadge-' + peerId);
  if (badge) { badge.textContent = msg; badge.className = 'peer-status-badge badge-' + type; }
}

function markPeerDone(peerId) {
  const card = document.getElementById('peer-' + peerId);
  const badge = document.getElementById('pbadge-' + peerId);
  const bar = document.getElementById('pbar-' + peerId);
  if (card)  card.classList.add('peer-done');
  if (badge) { badge.textContent = '✓ Done'; badge.className = 'peer-status-badge badge-done'; }
  if (bar)   bar.style.width = '100%';
}

function markPeerLeft(peerId) {
  const badge = document.getElementById('pbadge-' + peerId);
  if (badge) { badge.textContent = 'Left'; badge.className = 'peer-status-badge badge-error'; }
}

function resetPeerList() {
  if (!UI.peerList) return;
  UI.peerList.innerHTML = '';
  UI.peerList.classList.remove('visible');
  if (UI.peerCount) UI.peerCount.textContent = '';
}

function updateSendProgress(peerId, pct, bytes, speed, total) {
  const prog = $('#progress-send');
  if (!prog) return;
  prog.classList.add('visible');
  const bar = $('#progress-bar-send');
  if (bar) bar.style.width = pct + '%';
  const pctEl = $('#progress-pct-send');
  if (pctEl) pctEl.textContent = pct + '%';
  const spd = $('#progress-speed');
  if (spd) spd.textContent = 'Speed: ' + safeFormatSpeed(speed);
  const sent = $('#progress-sent');
  if (sent) sent.textContent = safeFormatSize(bytes) + ' / ' + safeFormatSize(total);
  const eta = $('#progress-eta');
  if (eta) eta.textContent = 'ETA: ' + safeFormatETA(total - bytes, speed);
}

/* ── CAMERA ──────────────────────────────────────────────────── */
function startCameraScanner() {
  UI.cameraView.classList.add('visible');
  scanner = new QRScanner(UI.cameraVideo, offCanvas,
    (text) => {
      UI.cameraView.classList.remove('visible');
      UI.linkInput.value = text;
      try {
        const url = new URL(text);
        if (url.searchParams.get('mode') === 'rf') { connectAsSender(text); return; }
      } catch(_) {}
      connectToSession(text);
    },
    (err) => { UI.cameraView.classList.remove('visible'); setStatus(UI.statusReceive, 'Camera error: ' + err.message, 'error'); }
  );
  scanner.start();
}

function stopCameraScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
  UI.cameraView.classList.remove('visible');
}

/* ── RECEIVE ─────────────────────────────────────────────────── */
function showIncomingFile(name, size) {
  if (UI.incomingFile) UI.incomingFile.classList.add('visible');
  if (UI.incomingName) UI.incomingName.textContent = safeFileEmoji(name) + ' ' + name;
  if (UI.incomingSize) UI.incomingSize.textContent = safeFormatSize(size);
}

function updateReceiveProgress(pct, bytes, speed, total) {
  if (UI.progressReceive) UI.progressReceive.classList.add('visible');
  const displayPct = Math.min(pct, 99);
  if (UI.progressBarR)   UI.progressBarR.style.width   = displayPct + '%';
  if (UI.progressPctR)   UI.progressPctR.textContent   = displayPct + '%';
  if (UI.progressSpeedR) UI.progressSpeedR.textContent = 'Speed: ' + safeFormatSpeed(speed);
  if (UI.progressETAR)   UI.progressETAR.textContent   = 'ETA: ' + safeFormatETA(total - bytes, speed);
  const label = $('#progress-label-r');
  if (label) label.textContent = displayPct >= 99 ? 'Assembling file…' : 'Receiving…';
}

function handleFileComplete(blob, fileName) {
  downloadBlob_ = blob; downloadName_ = fileName;
  if (UI.progressBarR)   UI.progressBarR.style.width   = '100%';
  if (UI.progressPctR)   UI.progressPctR.textContent   = '100%';
  if (UI.progressSpeedR) UI.progressSpeedR.textContent = '✓ Complete';
  if (UI.progressETAR)   UI.progressETAR.textContent   = 'Done!';
  const label = $('#progress-label-r');
  if (label) label.textContent = 'Transfer complete!';
  if (UI.btnDownload) { UI.btnDownload.classList.remove('hidden'); UI.btnDownload.classList.add('visible'); }
  setStatus(UI.statusReceive, '✓ File received! Click Download to save.', 'done');
  safeDownloadBlob(blob, fileName);
}

function triggerDownload() {
  if (downloadBlob_ && downloadName_) safeDownloadBlob(downloadBlob_, downloadName_);
}

function copySessionLink() {
  const link = UI.sessionLinkSpan.textContent;
  navigator.clipboard.writeText(link).then(() => { UI.btnCopy.textContent = '✓ Copied!'; setTimeout(() => (UI.btnCopy.textContent = 'Copy'), 2000); });
}

function copyMyLink() {
  const link = UI.mySessionLink.textContent;
  navigator.clipboard.writeText(link).then(() => { UI.btnCopyMyLink.textContent = '✓ Copied!'; setTimeout(() => (UI.btnCopyMyLink.textContent = 'Copy'), 2000); });
}

/* ── SIGNALING ───────────────────────────────────────────────── */
function connectSignaling() {
  if (typeof io === 'undefined') throw new Error('Socket.io not loaded.');
  const sock = io(SIGNALING_URL, {
    transports:           ['websocket', 'polling'], // polling as fallback
    timeout:              8000,
    reconnectionAttempts: 10,       // more retries
    reconnectionDelay:    1000,     // wait 1s between retries
    reconnectionDelayMax: 5000,     // max 5s wait
    randomizationFactor:  0.5,
    forceNew:             false,    // reuse connection
    upgrade:              true,     // allow upgrade to websocket
  });

  // Log disconnections for debugging
  sock.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    if (reason === 'io server disconnect') {
      // Server forced disconnect — reconnect manually
      sock.connect();
    }
  });

  sock.on('reconnect', (attempt) => {
    console.log('[Socket] Reconnected after', attempt, 'attempts');
  });

  sock.on('reconnect_error', (err) => {
    console.warn('[Socket] Reconnect error:', err.message);
  });

  return sock;
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server took too long. Try refreshing the page.')), timeoutMs);
    socket.once(event, () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', (e) => {
      clearTimeout(t);
      // Don't reject on first connect error — socket will retry automatically
      console.warn('[Socket] Connect error:', e.message, '— retrying…');
    });
  });
}

function initContactForm() {
  const form = $('#contact-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.style.display = 'none';
    const s = $('#form-success');
    if (s) s.classList.add('visible');
  });
}

function setStatus(el, msg, type) {
  if (!el || !msg) { if (el) el.innerHTML = ''; return; }
  const icons = { waiting: '⏳', connect: '🔗', transfer: '📤', done: '✅', error: '❌' };
  el.innerHTML = `<span>${icons[type] || '•'}</span> ${msg}`;
  el.className = 'status-msg status-' + (type || 'waiting');
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
