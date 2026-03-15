/**
 * qr.js — QR Code generation + camera-based scanning
 * ─────────────────────────────────────────────────────────────
 * Uses:
 *  - QRCode.js (CDN) for generation
 *  - jsQR (CDN) for decoding from camera stream
 *
 * Both libraries are loaded via <script> tags in HTML so this file
 * stays dependency-free and works offline after first load.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   QR GENERATOR
   ═══════════════════════════════════════════════════════════════ */

/**
 * generateQR — render a QR code into a container element
 * @param {string} text   — the URL / data to encode
 * @param {HTMLElement} container — element to render into
 * @param {number} [size=200]    — pixel size
 * @returns {Promise<void>}
 */
async function generateQR(text, container, size = 200) {
  // Clear previous content
  container.innerHTML = '';

  if (typeof QRCode === 'undefined') {
    throw new Error('QRCode library not loaded. Check your <script> tags.');
  }

  // QRCode.js creates a canvas element inside the container
  new QRCode(container, {
    text,
    width:          size,
    height:         size,
    colorDark:      '#1a1916',
    colorLight:     '#ffffff',
    correctLevel:   QRCode.CorrectLevel.M,   // Medium error correction
  });
}

/* ═══════════════════════════════════════════════════════════════
   QR SCANNER (Camera)
   ═══════════════════════════════════════════════════════════════ */

class QRScanner {
  /**
   * @param {HTMLVideoElement} videoEl  — <video> element to stream camera into
   * @param {HTMLCanvasElement} canvasEl — off-screen canvas for frame capture
   * @param {Function} onResult (text) — called when a QR code is decoded
   * @param {Function} onError  (err)  — called on camera / decode error
   */
  constructor(videoEl, canvasEl, onResult, onError) {
    this._video    = videoEl;
    this._canvas   = canvasEl || document.createElement('canvas');
    this._ctx      = this._canvas.getContext('2d');
    this._onResult = onResult;
    this._onError  = onError;
    this._stream   = null;
    this._rafId    = null;
    this._active   = false;
  }

  /**
   * start — request camera permission and begin scanning
   */
  async start() {
    if (typeof jsQR === 'undefined') {
      this._onError(new Error('jsQR library not loaded.'));
      return;
    }

    try {
      // Prefer rear camera on mobile devices
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        }
      };

      this._stream = await navigator.mediaDevices.getUserMedia(constraints);
      this._video.srcObject = this._stream;
      this._video.setAttribute('playsinline', true); // Required for iOS Safari
      await this._video.play();

      this._active = true;
      this._scan();
    } catch (err) {
      this._onError(err);
    }
  }

  /**
   * stop — release camera and stop scanning loop
   */
  stop() {
    this._active = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    this._video.srcObject = null;
  }

  /**
   * _scan — RAF loop: capture frame → decode with jsQR
   */
  _scan() {
    if (!this._active) return;

    if (this._video.readyState === this._video.HAVE_ENOUGH_DATA) {
      const w = this._video.videoWidth;
      const h = this._video.videoHeight;

      this._canvas.width  = w;
      this._canvas.height = h;
      this._ctx.drawImage(this._video, 0, 0, w, h);

      const imageData = this._ctx.getImageData(0, 0, w, h);
      const code = jsQR(imageData.data, w, h, {
        inversionAttempts: 'dontInvert',
      });

      if (code && code.data) {
        this.stop();
        this._onResult(code.data);
        return; // Don't schedule next frame after success
      }
    }

    this._rafId = requestAnimationFrame(() => this._scan());
  }
}

/* ── Utility: format file size ─────────────────────────────── */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/* ── Utility: format transfer speed ───────────────────────── */
function formatSpeed(bytesPerSec) {
  return formatSize(bytesPerSec) + '/s';
}

/* ── Utility: estimate time remaining ─────────────────────── */
function formatETA(bytesRemaining, speed) {
  if (!speed || speed === 0) return '—';
  const secs = Math.ceil(bytesRemaining / speed);
  if (secs < 60)  return secs + 's';
  if (secs < 3600) return Math.ceil(secs / 60) + 'm';
  return Math.ceil(secs / 3600) + 'h';
}

/* ── Utility: trigger file download in browser ─────────────── */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to allow download to start
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ── Utility: get file emoji by extension ─────────────────── */
function fileEmoji(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const map = {
    pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📋', pptx: '📋',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵',
    zip: '🗜️', rar: '🗜️', tar: '🗜️', gz: '🗜️', '7z': '🗜️',
    js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻', json: '💻',
    exe: '⚙️', dmg: '⚙️', pkg: '⚙️',
    apk: '📱',
  };
  return map[ext] || '📁';
}

/* Expose globally */
window.generateQR  = generateQR;
window.QRScanner   = QRScanner;
window.formatSize  = formatSize;
window.formatSpeed = formatSpeed;
window.formatETA   = formatETA;
window.downloadBlob = downloadBlob;
window.fileEmoji   = fileEmoji;
