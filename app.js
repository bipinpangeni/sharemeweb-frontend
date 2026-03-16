/**
 * app.js — ShareMeWeb v2
 * ─────────────────────────────────────────────────────────────
 * New features:
 *  1. Multi-receiver: sender can share to unlimited peers
 *  2. Live peer list showing each receiver's progress
 *  3. Receiver-first mode: receiver shows QR, sender scans
 *  4. Faster transfer feedback
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const SIGNALING_URL = (() => {
  const meta = document.querySelector('meta[name="signaling-url"]');
  return meta ? meta.content : 'http://localhost:3001';
})();

const $ = (sel) => document.querySelector(sel);

/* ── DOM refs ──────────────────────────────────────────────── */
const UI = {
  tabSend:         $('#tab-send'),
  tabReceive:      $('#tab-receive'),
  panelSend:       $('#panel-send'),
  panelReceive:    $('#panel-receive'),

  /* Send */
  uploadZone:      $('#upload-zone'),
  fileInput:       $('#file-input'),
  fileInfoStrip:   $('#file-info-strip'),
  fileIcon:        $('#file-icon'),
  fileName:        $('#file-name'),
  fileSize:        $('#file-size'),
  btnClear:        $('#btn-clear'),
  btnGenerate:     $('#btn-generate'),
  qrSection:       $('#qr-section'),
  qrContainer:     $('#qr-container'),
  sessionLinkSpan: $('#session-link'),
  btnCopy:         $('#btn-copy'),
  statusSend:      $('#status-send'),
  peerList:        $('#peer-list'),         // NEW: list of connected receivers
  peerCount:       $('#peer-count'),        // NEW: "3 receivers connected"

  /* Receive */
  btnScanQR:       $('#btn-scan-qr'),
  btnShowMyQR:     $('#btn-show-my-qr'),    // NEW: receiver generates QR
  myQRSection:     $('#my-qr-section'),     // NEW: receiver's QR panel
  myQRContainer:   $('#my-qr-container'),   // NEW
  mySessionLink:   $('#my-session-link'),   // NEW
  btnCopyMyLink:   $('#btn-copy-my-link'),  // NEW
  cameraView:      $('#camera-view'),
  cameraVideo:     $('#camera-video'),
  btnCameraStop:   $('#btn-camera-stop'),
  linkInput:       $('#link-input'),
  btnConnect:      $('#btn-connect'),
  statusReceive:   $('#status-receive'),
  incomingFile:    $('#incoming-file'),
  incomingName:    $('#incoming-name'),
  incomingSize:    $('#incoming-size'),
  progressReceive: $('#progress-receive'),
  progressBarR:    $('#progress-bar-receive'),
  progressPctR:    $('#progress-pct-receive'),
  progressSpeedR:  $('#progress-speed-r'),
  progressETAR:    $('#progress-eta-r'),
  btnDownload:     $('#btn-download'),

  hamburger:       $('#hamburger'),
  navLinks:        $('#nav-links'),
};

/* ── State ─────────────────────────────────────────────────── */
let selectedFile   = null;
let multiSender    = null;   // MultiSender instance (sender side)
let rtcReceive     = null;   // ShareDropRTC instance (receiver side)
let socket         = null;
let sessionId      = null;
let downloadBlob_  = null;
let downloadName_  = '';
let scanner        = null;
let sessionMode    = 'sender-first'; // 'sender-first' | 'receiver-first'
const offCanvas    = document.createElement('canvas');

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initTabs();
  initUploadZone();
  checkURLForSession();
  initContactForm();
});

/* ── Nav ───────────────────────────────────────────────────── */
function initNav() {
  if (!UI.hamburger) return;
  UI.hamburger.addEventListener('click', () => UI.navLinks.classList.toggle('open'));
}

/* ── Tabs ──────────────────────────────────────────────────── */
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

/* ── Auto-detect session in URL ────────────────────────────── */
function checkURLForSession() {
  const params = new URLSearchParams(window.location.search);
  const sid    = params.get('s');
  const mode   = params.get('mode'); // 'rf' = receiver-first

  if (sid && UI.linkInput) {
    UI.linkInput.value = window.location.href;
    switchTab('receive');

    if (mode === 'rf') {
      // Receiver-first: this is the SENDER scanning receiver's QR
      setTimeout(() => connectAsSender(window.location.href), 400);
    } else {
      // Normal: this is the RECEIVER scanning sender's QR
      setTimeout(() => connectToSession(window.location.href), 400);
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   UPLOAD ZONE
   ══════════════════════════════════════════════════════════════ */
function initUploadZone() {
  if (!UI.uploadZone) return;

  UI.uploadZone.addEventListener('click', (e) => {
    if (e.target !== UI.fileInput) UI.fileInput.click();
  });
  UI.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault(); UI.uploadZone.classList.add('dragover');
  });
  UI.uploadZone.addEventListener('dragleave', () => UI.uploadZone.classList.remove('dragover'));
  UI.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault(); UI.uploadZone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelected(f);
  });
  UI.fileInput.addEventListener('change', () => {
    if (UI.fileInput.files[0]) handleFileSelected(UI.fileInput.files[0]);
  });
  UI.btnClear.addEventListener('click', clearFile);
  UI.btnGenerate.addEventListener('click', startSenderSession);
  UI.btnCopy.addEventListener('click', copySessionLink);

  /* Receive side */
  if (UI.btnScanQR)    UI.btnScanQR.addEventListener('click', startCameraScanner);
  if (UI.btnCameraStop) UI.btnCameraStop.addEventListener('click', stopCameraScanner);
  if (UI.btnConnect)   UI.btnConnect.addEventListener('click', () => connectToSession(UI.linkInput.value.trim()));
  if (UI.btnDownload)  UI.btnDownload.addEventListener('click', triggerDownload);

  /* NEW: Receiver-first button */
  if (UI.btnShowMyQR)  UI.btnShowMyQR.addEventListener('click', startReceiverFirstSession);
  if (UI.btnCopyMyLink) UI.btnCopyMyLink.addEventListener('click', copyMyLink);
}

/* ── File selected ─────────────────────────────────────────── */
function handleFileSelected(file) {
  selectedFile = file;
  UI.fileIcon.textContent = fileEmoji(file.name);
  UI.fileName.textContent = file.name;
  UI.fileSize.textContent = formatSize(file.size);
  UI.fileInfoStrip.classList.add('visible');
  UI.btnGenerate.disabled = false;
  UI.qrSection.classList.remove('visible');
  setStatus(UI.statusSend, '', '');
  resetPeerList();
}

function clearFile() {
  selectedFile = null;
  UI.fileInput.value = '';
  UI.fileInfoStrip.classList.remove('visible');
  UI.btnGenerate.disabled = true;
  UI.qrSection.classList.remove('visible');
  setStatus(UI.statusSend, '', '');
  resetPeerList();
  if (multiSender) { multiSender.destroyAll(); multiSender = null; }
  if (socket)      { socket.disconnect(); socket = null; }
}

/* ══════════════════════════════════════════════════════════════
   SENDER-FIRST FLOW
   ══════════════════════════════════════════════════════════════ */
async function startSenderSession() {
  if (!selectedFile) return;

  sessionMode = 'sender-first';
  UI.btnGenerate.disabled = true;
  UI.btnGenerate.innerHTML = '<span class="spinner"></span> Connecting…';

  try {
    socket    = connectSignaling();
    sessionId = generateId();

    await waitFor(socket, 'connect', 6000);
    socket.emit('create-session', { sessionId, mode: 'sender-first' });

    /* Create MultiSender — handles all incoming receivers */
    multiSender = new MultiSender(selectedFile, {
      onPeerProgress: (pid, pct, bytes, speed, total) => updatePeerProgress(pid, pct, bytes, speed, total),
      onPeerComplete: (pid) => markPeerDone(pid),
      onPeerStatus:   (pid, msg, type) => updatePeerStatus(pid, msg, type),
      onIceCandidate: (pid, cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'sender', peerId: pid }),
    });

    /* Build session URL */
    const sessionURL = `${window.location.origin}/?s=${sessionId}`;
    UI.qrSection.classList.add('visible');
    await generateQR(sessionURL, UI.qrContainer, 200);
    UI.sessionLinkSpan.textContent = sessionURL;
    setStatus(UI.statusSend, 'Session ready — waiting for receivers…', 'waiting');

    /* ── Handle each new receiver joining ─────────────────── */
    socket.on('peer-joined', async ({ peerId }) => {
      const peerRtc = multiSender.addPeer(peerId);
      addPeerCard(peerId);

      /* Create a fresh WebRTC offer for this specific receiver */
      const offer = await peerRtc.createOffer();
      socket.emit('offer', { sessionId, sdp: offer, peerId });

      updatePeerStatus(peerId, 'Offer sent — waiting for answer…', 'waiting');
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

    socket.on('peer-left', ({ peerId }) => {
      markPeerLeft(peerId);
    });

    socket.on('error', (msg) => setStatus(UI.statusSend, 'Error: ' + msg, 'error'));

  } catch (err) {
    setStatus(UI.statusSend, 'Failed: ' + err.message, 'error');
    console.error(err);
  } finally {
    UI.btnGenerate.disabled = false;
    UI.btnGenerate.textContent = '🔄 Regenerate';
  }
}

/* ══════════════════════════════════════════════════════════════
   RECEIVER-FIRST FLOW
   Receiver generates QR code → sender scans it → sender picks file
   ══════════════════════════════════════════════════════════════ */
async function startReceiverFirstSession() {
  sessionMode = 'receiver-first';
  UI.btnShowMyQR.disabled = true;
  UI.btnShowMyQR.innerHTML = '<span class="spinner"></span> Generating…';

  try {
    socket    = connectSignaling();
    sessionId = generateId();

    await waitFor(socket, 'connect', 6000);
    socket.emit('create-session', { sessionId, mode: 'receiver-first' });

    /* Receiver creates the WebRTC offer */
    rtcReceive = new ShareDropRTC({
      onProgress:    updateReceiveProgress,
      onComplete:    handleFileComplete,
      onStatus:      (msg, type) => setStatus(UI.statusReceive, msg, type),
      onFileInfo:    showIncomingFile,
      onIceCandidate:(cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'receiver' }),
    });

    const offer = await rtcReceive.createReceiverOffer();
    socket.emit('offer', { sessionId, sdp: offer });

    /* Build session URL with mode flag */
    const sessionURL = `${window.location.origin}/?s=${sessionId}&mode=rf`;

    /* Show QR on receiver side */
    UI.myQRSection.style.display = 'block';
    UI.myQRSection.classList.add('visible');
    await generateQR(sessionURL, UI.myQRContainer, 200);
    UI.mySessionLink.textContent = sessionURL;
    setStatus(UI.statusReceive, 'Show this QR to the sender — waiting…', 'waiting');

    /* Handle sender's answer */
    socket.on('answer', async ({ sdp }) => {
      await rtcReceive.handleSenderAnswer(sdp);
    });

    socket.on('ice-candidate', async ({ candidate, role }) => {
      if (role === 'sender') await rtcReceive.addIceCandidate(candidate);
    });

    socket.on('error', (msg) => setStatus(UI.statusReceive, 'Error: ' + msg, 'error'));

  } catch (err) {
    setStatus(UI.statusReceive, 'Failed: ' + err.message, 'error');
  } finally {
    UI.btnShowMyQR.disabled = false;
    UI.btnShowMyQR.textContent = '📱 Show My QR Code';
  }
}

/* Sender scans receiver's QR code */
async function connectAsSender(rawLink) {
  let sid;
  try { sid = new URL(rawLink).searchParams.get('s'); }
  catch(_) { sid = rawLink.trim(); }

  if (!sid) { setStatus(UI.statusReceive, 'Invalid link.', 'error'); return; }

  // Switch to send tab and prompt file selection
  switchTab('send');
  setStatus(UI.statusSend, '📱 Receiver QR scanned! Now select a file to send.', 'waiting');

  // Store pending session for when sender picks file
  window._pendingReceiverSession = sid;

  // Override generate button behavior for this one-time session
  const origHandler = UI.btnGenerate.onclick;
  UI.btnGenerate.onclick = async () => {
    if (!selectedFile) return;
    await sendToReceiverFirst(window._pendingReceiverSession);
    UI.btnGenerate.onclick = origHandler;
    window._pendingReceiverSession = null;
  };
}

async function sendToReceiverFirst(sid) {
  sessionId   = sid;
  sessionMode = 'receiver-first';
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

    socket.on('ice-candidate', async ({ candidate, role }) => {
      // handled in ShareDropRTC
    });

  } catch (err) {
    setStatus(UI.statusSend, 'Failed: ' + err.message, 'error');
  } finally {
    UI.btnGenerate.disabled = false;
    UI.btnGenerate.textContent = 'Generate QR Code & Share Link →';
  }
}

/* ══════════════════════════════════════════════════════════════
   RECEIVER FLOW (normal — scanning sender's QR)
   ══════════════════════════════════════════════════════════════ */
function connectToSession(rawLink) {
  let sid;
  try { sid = new URL(rawLink).searchParams.get('s'); }
  catch(_) { sid = rawLink.trim(); }

  if (!sid) { setStatus(UI.statusReceive, 'Invalid link.', 'error'); return; }

  sessionId = sid;
  const peerId = generateId(); // unique ID for this receiver
  setStatus(UI.statusReceive, 'Connecting to session…', 'waiting');

  socket = connectSignaling();

  socket.on('connect', () => {
    socket.emit('join-session', { sessionId, peerId });
  });

  socket.on('offer', async ({ sdp }) => {
    rtcReceive = new ShareDropRTC({
      onProgress:    updateReceiveProgress,
      onComplete:    handleFileComplete,
      onStatus:      (msg, type) => setStatus(UI.statusReceive, msg, type),
      onFileInfo:    showIncomingFile,
      onIceCandidate:(cand) => socket.emit('ice-candidate', { sessionId, candidate: cand, role: 'receiver', peerId }),
    });

    const answer = await rtcReceive.createAnswer(sdp);
    socket.emit('answer', { sessionId, sdp: answer, peerId });
  });

  socket.on('ice-candidate', async ({ candidate, role }) => {
    if (role === 'sender' && rtcReceive) await rtcReceive.addIceCandidate(candidate);
  });

  socket.on('session-not-found', () => {
    setStatus(UI.statusReceive, 'Session not found or expired.', 'error');
  });

  socket.on('connect_error', () => {
    setStatus(UI.statusReceive, 'Cannot reach server. Check your connection.', 'error');
  });
}

/* ══════════════════════════════════════════════════════════════
   PEER LIST UI (multi-receiver display on sender side)
   ══════════════════════════════════════════════════════════════ */
function addPeerCard(peerId) {
  if (!UI.peerList) return;
  UI.peerList.classList.add('visible');

  const card = document.createElement('div');
  card.className = 'peer-card fade-in';
  card.id        = 'peer-' + peerId;
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
    </div>
  `;
  UI.peerList.appendChild(card);

  // Update counter
  const count = UI.peerList.children.length;
  if (UI.peerCount) UI.peerCount.textContent = count + ' receiver' + (count > 1 ? 's' : '') + ' connected';
}

function updatePeerProgress(peerId, pct, bytes, speed, total) {
  const bar   = document.getElementById('pbar-' + peerId);
  const pct_  = document.getElementById('ppct-' + peerId);
  const spd   = document.getElementById('pspeed-' + peerId);
  const eta   = document.getElementById('peta-' + peerId);
  const badge = document.getElementById('pbadge-' + peerId);

  if (bar)   bar.style.width         = pct + '%';
  if (pct_)  pct_.textContent        = pct + '%';
  if (spd)   spd.textContent         = formatSpeed(speed);
  if (eta)   eta.textContent         = formatETA(total - bytes, speed);
  if (badge) badge.textContent       = 'Transferring…';
  if (badge) badge.className         = 'peer-status-badge badge-transfer';
}

function updatePeerStatus(peerId, msg, type) {
  const badge = document.getElementById('pbadge-' + peerId);
  if (badge) { badge.textContent = msg; badge.className = 'peer-status-badge badge-' + type; }
}

function markPeerDone(peerId) {
  const card  = document.getElementById('peer-' + peerId);
  const badge = document.getElementById('pbadge-' + peerId);
  const bar   = document.getElementById('pbar-' + peerId);
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

/* ── Send progress (single peer / receiver-first mode) ─────── */
function updateSendProgress(peerId, pct, bytes, speed, total) {
  // Show a simple progress bar on the send panel
  const prog = $('#progress-send');
  if (!prog) return;
  prog.classList.add('visible');
  const bar = $('#progress-bar-send');
  if (bar) bar.style.width = pct + '%';
  const pctEl = $('#progress-pct-send');
  if (pctEl) pctEl.textContent = pct + '%';
  const spd = $('#progress-speed');
  if (spd) spd.textContent = 'Speed: ' + formatSpeed(speed);
  const sent = $('#progress-sent');
  if (sent) sent.textContent = formatSize(bytes) + ' / ' + formatSize(total);
  const eta = $('#progress-eta');
  if (eta) eta.textContent = 'ETA: ' + formatETA(total - bytes, speed);
}

/* ══════════════════════════════════════════════════════════════
   CAMERA SCANNER
   ══════════════════════════════════════════════════════════════ */
function startCameraScanner() {
  UI.cameraView.classList.add('visible');
  scanner = new QRScanner(
    UI.cameraVideo,
    offCanvas,
    (text) => {
      UI.cameraView.classList.remove('visible');
      UI.linkInput.value = text;

      // Check if this is a receiver-first QR (mode=rf)
      try {
        const url  = new URL(text);
        const mode = url.searchParams.get('mode');
        if (mode === 'rf') {
          connectAsSender(text);
          return;
        }
      } catch(_) {}

      connectToSession(text);
    },
    (err) => {
      UI.cameraView.classList.remove('visible');
      setStatus(UI.statusReceive, 'Camera error: ' + err.message, 'error');
    }
  );
  scanner.start();
}

function stopCameraScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
  UI.cameraView.classList.remove('visible');
}

/* ── Receive progress & completion ─────────────────────────── */
function showIncomingFile(name, size) {
  if (UI.incomingFile) UI.incomingFile.classList.add('visible');
  if (UI.incomingName) UI.incomingName.textContent = fileEmoji(name) + ' ' + name;
  if (UI.incomingSize) UI.incomingSize.textContent = formatSize(size);
}

function updateReceiveProgress(pct, bytes, speed, total) {
  if (UI.progressReceive) UI.progressReceive.classList.add('visible');

  // Cap at 99% — only jump to 100% when file is FULLY assembled
  const displayPct = Math.min(pct, 99);

  if (UI.progressBarR)   UI.progressBarR.style.width   = displayPct + '%';
  if (UI.progressPctR)   UI.progressPctR.textContent   = displayPct + '%';
  if (UI.progressSpeedR) UI.progressSpeedR.textContent = 'Speed: ' + formatSpeed(speed);
  if (UI.progressETAR)   UI.progressETAR.textContent   = 'ETA: ' + formatETA(total - bytes, speed);
}

function handleFileComplete(blob, fileName) {
  downloadBlob_ = blob;
  downloadName_ = fileName;

  // NOW show 100% — file fully assembled and ready to download
  if (UI.progressBarR)   UI.progressBarR.style.width   = '100%';
  if (UI.progressPctR)   UI.progressPctR.textContent   = '100%';
  if (UI.progressSpeedR) UI.progressSpeedR.textContent = '✓ Complete';
  if (UI.progressETAR)   UI.progressETAR.textContent   = 'Done!';

  // Show download button
  if (UI.btnDownload) {
    UI.btnDownload.classList.remove('hidden');
    UI.btnDownload.classList.add('visible');
  }

  setStatus(UI.statusReceive, '✓ File received! Click Download to save.', 'done');
  downloadBlob(blob, fileName); // auto-download
}

function triggerDownload() {
  if (downloadBlob_ && downloadName_) downloadBlob(downloadBlob_, downloadName_);
}

/* ── Copy buttons ──────────────────────────────────────────── */
function copySessionLink() {
  const link = UI.sessionLinkSpan.textContent;
  navigator.clipboard.writeText(link).then(() => {
    UI.btnCopy.textContent = '✓ Copied!';
    setTimeout(() => (UI.btnCopy.textContent = 'Copy'), 2000);
  });
}

function copyMyLink() {
  const link = UI.mySessionLink.textContent;
  navigator.clipboard.writeText(link).then(() => {
    UI.btnCopyMyLink.textContent = '✓ Copied!';
    setTimeout(() => (UI.btnCopyMyLink.textContent = 'Copy'), 2000);
  });
}

/* ══════════════════════════════════════════════════════════════
   SIGNALING
   ══════════════════════════════════════════════════════════════ */
function connectSignaling() {
  if (typeof io === 'undefined') throw new Error('Socket.io not loaded.');
  return io(SIGNALING_URL, {
    transports:          ['websocket', 'polling'],
    timeout:             10000,
    reconnectionAttempts: 3,
  });
}

function waitFor(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout: ' + event)), timeoutMs);
    socket.once(event, () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

/* ══════════════════════════════════════════════════════════════
   CONTACT FORM
   ══════════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */
function setStatus(el, msg, type) {
  if (!el || !msg) { if (el) el.innerHTML = ''; return; }
  const icons = { waiting: '⏳', connect: '🔗', transfer: '📤', done: '✅', error: '❌' };
  el.innerHTML = `<span>${icons[type] || '•'}</span> ${msg}`;
  el.className = 'status-msg status-' + (type || 'waiting');
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
