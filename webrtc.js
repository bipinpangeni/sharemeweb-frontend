/**
 * webrtc.js — ShareMeWeb WebRTC Engine v6
 * ─────────────────────────────────────────────────────────────
 * Fixes "channel closed" during transfer:
 *  - Chunk size reduced to 64KB (most stable size)
 *  - Buffer threshold lowered to prevent overflow drops
 *  - Heartbeat PAUSED during transfer (no competition)
 *  - Channel close = auto retry transfer
 *  - Graceful error handling on every send
 *  - Multiple TURN servers for stable relay
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const CHUNK_SIZE       = 64 * 1024;       // 64 KB — most stable, widely supported
const BUFFER_THRESHOLD = 1 * 1024 * 1024; // 1 MB max — lower = less drops
const BUFFER_LOW       = 256 * 1024;      // Resume at 256 KB
const HEARTBEAT_MS     = 5000;            // Ping every 5s (paused during transfer)
const MAX_RETRIES      = 5;

const ICE_SERVERS = [
  /* STUN servers */
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:free.expressturn.com:3478' },

  /* ExpressTURN — relay for different networks */
  {
    urls:       'turn:free.expressturn.com:3478',
    username:   '000000002089102638',
    credential: 'KdrJQCOERLu3h8x1R9rSdmxd7yA=',
  },
  {
    urls:       'turn:free.expressturn.com:3478?transport=tcp',
    username:   '000000002089102638',
    credential: 'KdrJQCOERLu3h8x1R9rSdmxd7yA=',
  },
];

class ShareDropRTC {
  constructor(opts = {}) {
    this.onProgress     = opts.onProgress     || (() => {});
    this.onComplete     = opts.onComplete     || (() => {});
    this.onStatus       = opts.onStatus       || (() => {});
    this.onFileInfo     = opts.onFileInfo     || (() => {});
    this.onIceCandidate = opts.onIceCandidate || (() => {});
    this.peerId         = opts.peerId         || 'peer';

    this._pc              = null;
    this._channel         = null;
    this._file            = null;
    this._chunks          = [];
    this._expectedSize    = 0;
    this._receivedSize    = 0;
    this._fileName        = '';
    this._fileType        = '';
    this._startTime       = 0;
    this._lastTime        = 0;
    this._lastBytes       = 0;
    this._paused          = false;
    this._sending         = false;
    this._offset          = 0;
    this._heartbeat       = null;
    this._retryCount      = 0;
    this._isTransferring  = false; // track if transfer active
    this._disconnectTimer = null;
  }

  /* ── Create peer connection ────────────────────────────────── */
  _createPeer() {
    const pc = new RTCPeerConnection({
      iceServers:         ICE_SERVERS,
      iceTransportPolicy: 'all',
      bundlePolicy:       'max-bundle',
      rtcpMuxPolicy:      'require',
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) this.onIceCandidate(e.candidate);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log('[RTC] Connection:', s);

      if (s === 'connected') {
        if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null; }
        this._retryCount = 0;
        this.onStatus('✅ Connected!', 'connect');
        // Only start heartbeat if NOT transferring
        if (!this._isTransferring) this._startHeartbeat();
      }

      if (s === 'disconnected') {
        this._stopHeartbeat();
        this.onStatus('⚠️ Connection unstable — holding on…', 'waiting');
        // Wait 5s for auto-recovery before ICE restart
        this._disconnectTimer = setTimeout(() => {
          if (this._pc && this._pc.connectionState === 'disconnected') {
            this.onStatus('🔄 Restarting connection…', 'waiting');
            try { this._pc.restartIce(); } catch(_) {}
          }
        }, 5000);
      }

      if (s === 'failed') {
        this._stopHeartbeat();
        if (this._retryCount < MAX_RETRIES) {
          this._retryCount++;
          this.onStatus(`🔄 Reconnecting… (${this._retryCount}/${MAX_RETRIES})`, 'waiting');
          setTimeout(() => {
            try { this._pc.restartIce(); } catch(_) {}
          }, 2000);
        } else {
          this.onStatus('❌ Connection failed. Please refresh and try again.', 'error');
        }
      }

      if (s === 'closed') this._stopHeartbeat();
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log('[ICE]', s);
      if (s === 'disconnected') {
        setTimeout(() => {
          if (this._pc && this._pc.iceConnectionState === 'disconnected') {
            try { this._pc.restartIce(); } catch(_) {}
          }
        }, 3000);
      }
    };

    return pc;
  }

  /* ── Heartbeat ─────────────────────────────────────────────── */
  _startHeartbeat() {
    this._stopHeartbeat();
    // Don't heartbeat during transfer — it competes with data
    if (this._isTransferring) return;
    this._heartbeat = setInterval(() => {
      if (this._channel && this._channel.readyState === 'open' && !this._isTransferring) {
        try { this._channel.send(JSON.stringify({ type: 'ping' })); } catch(_) {}
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  /* ══════════════════════════════════════════════════════════
     SENDER SIDE
     ══════════════════════════════════════════════════════════ */
  setFile(file) { this._file = file; }

  async createOffer() {
    this._pc = this._createPeer();
    this._channel = this._pc.createDataChannel('file-transfer', {
      ordered:        true,
      maxRetransmits: null, // unlimited retransmits = reliable
    });
    this._channel.binaryType = 'arraybuffer';
    this._channel.bufferedAmountLowThreshold = BUFFER_LOW;
    this._setupSenderChannel(this._channel);
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForICE();
    return this._pc.localDescription;
  }

  async handleAnswer(answer) {
    if (!this._pc) throw new Error('No peer connection.');
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.onStatus('Receiver connected — starting transfer…', 'transfer');
  }

  async answerReceiverOffer(offer) {
    this._pc = this._createPeer();
    this._channel = this._pc.createDataChannel('file-transfer', { ordered: true });
    this._channel.binaryType = 'arraybuffer';
    this._channel.bufferedAmountLowThreshold = BUFFER_LOW;
    this._setupSenderChannel(this._channel);
    await this._pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    await this._waitForICE();
    return this._pc.localDescription;
  }

  async addIceCandidate(candidate) {
    if (!this._pc) return;
    try { await this._pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e) { console.warn('[ICE candidate]', e.message); }
  }

  /* ── Sender channel setup ──────────────────────────────────── */
  _setupSenderChannel(ch) {
    ch.onopen = () => {
      this.onStatus('Channel open — sending file…', 'transfer');
      this._sendFile();
    };

    // Resume when buffer drains
    ch.onbufferedamountlow = () => {
      if (this._paused) {
        this._paused  = false;
        this._sending = false;
        this._sendFile();
      }
    };

    ch.onerror = (e) => {
      console.error('[Channel error]', e);
      this._sending = false;
      this.onStatus('⚠️ Channel error — will retry…', 'waiting');
    };

    ch.onclose = () => {
      this._stopHeartbeat();
      this._sending      = false;
      this._isTransferring = false;
      const progress = this._offset / (this._file ? this._file.size : 1);
      if (this._file && this._offset > 0 && this._offset < this._file.size) {
        this.onStatus('⚠️ Channel closed at ' + Math.round(progress*100) + '% — reconnecting…', 'waiting');
      }
    };
  }

  /* ── File sending — controlled flow ────────────────────────── */
  async _sendFile() {
    if (!this._file || !this._channel || this._sending) return;
    if (this._channel.readyState !== 'open') {
      this.onStatus('⚠️ Channel not ready.', 'waiting');
      return;
    }

    this._sending      = true;
    this._isTransferring = true;
    this._stopHeartbeat(); // Stop heartbeat during transfer

    const file      = this._file;
    const totalSize = file.size;

    // Send metadata on first start
    if (this._offset === 0) {
      try {
        this._channel.send(JSON.stringify({
          type:     'meta',
          name:     file.name,
          size:     file.size,
          mimeType: file.type || 'application/octet-stream',
        }));
      } catch(e) {
        this._sending = false;
        this._isTransferring = false;
        return;
      }
      this._startTime = Date.now();
      this._lastTime  = this._startTime;
      this._lastBytes = 0;
    }

    // Send one chunk at a time — most stable approach
    while (this._offset < totalSize) {

      // Check channel still open
      if (!this._channel || this._channel.readyState !== 'open') {
        this._sending      = false;
        this._isTransferring = false;
        return;
      }

      // Back-pressure — wait for buffer to drain
      if (this._channel.bufferedAmount > BUFFER_THRESHOLD) {
        this._paused  = true;
        this._sending = false;
        // Don't set isTransferring false — we'll resume
        return;
      }

      // Read one chunk
      const end    = Math.min(this._offset + CHUNK_SIZE, totalSize);
      const slice  = file.slice(this._offset, end);
      let buffer;
      try {
        buffer = await slice.arrayBuffer();
      } catch(e) {
        this._sending      = false;
        this._isTransferring = false;
        return;
      }

      // Send chunk
      try {
        this._channel.send(buffer);
      } catch(e) {
        console.warn('[Send error]', e.message);
        this._sending      = false;
        this._isTransferring = false;
        return;
      }

      this._offset += buffer.byteLength;

      // Progress update
      const pct   = Math.round((this._offset / totalSize) * 100);
      const now   = Date.now();
      const dt    = Math.max((now - this._lastTime) / 1000, 0.001);
      const speed = (this._offset - this._lastBytes) / dt;
      this._lastTime  = now;
      this._lastBytes = this._offset;
      this.onProgress(pct, this._offset, speed, totalSize);

      // Yield to browser every 10 chunks to keep UI alive
      if ((this._offset / CHUNK_SIZE) % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Transfer complete!
    try { this._channel.send(JSON.stringify({ type: 'end' })); } catch(_) {}
    this._sending      = false;
    this._isTransferring = false;
    this._offset = 0;
    this.onStatus('✓ File sent successfully!', 'done');
    this.onComplete();
    // Resume heartbeat after transfer done
    this._startHeartbeat();
  }

  /* ══════════════════════════════════════════════════════════
     RECEIVER SIDE
     ══════════════════════════════════════════════════════════ */
  async createAnswer(offer) {
    this._pc = this._createPeer();
    this._pc.ondatachannel = (e) => {
      this._channel = e.channel;
      this._channel.binaryType = 'arraybuffer';
      this._setupReceiverChannel(this._channel);
    };
    await this._pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    await this._waitForICE();
    return this._pc.localDescription;
  }

  async createReceiverOffer() {
    this._pc = this._createPeer();
    this._pc.ondatachannel = (e) => {
      this._channel = e.channel;
      this._channel.binaryType = 'arraybuffer';
      this._setupReceiverChannel(this._channel);
    };
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForICE();
    return this._pc.localDescription;
  }

  async handleSenderAnswer(answer) {
    if (!this._pc) throw new Error('No peer connection.');
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.onStatus('Sender connected — waiting for file…', 'connect');
  }

  /* ── Receiver channel ──────────────────────────────────────── */
  _setupReceiverChannel(ch) {
    this._chunks       = [];
    this._receivedSize = 0;
    this._isTransferring = false;

    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') return; // ignore heartbeat
          if (msg.type === 'meta') {
            this._fileName     = msg.name;
            this._fileType     = msg.mimeType;
            this._expectedSize = msg.size;
            this._startTime    = Date.now();
            this._lastTime     = this._startTime;
            this._lastBytes    = 0;
            this._isTransferring = true;
            this._stopHeartbeat(); // pause heartbeat during receive
            this.onFileInfo(msg.name, msg.size);
            this.onStatus('Receiving: ' + msg.name, 'transfer');
          }
          if (msg.type === 'end') {
            this._isTransferring = false;
            this._assembleFile();
          }
        } catch(_) {}
        return;
      }

      // Binary chunk
      this._chunks.push(e.data);
      this._receivedSize += e.data.byteLength;

      const pct   = Math.round((this._receivedSize / this._expectedSize) * 100);
      const now   = Date.now();
      const dt    = Math.max((now - this._lastTime) / 1000, 0.001);
      const speed = (this._receivedSize - this._lastBytes) / dt;
      this._lastTime  = now;
      this._lastBytes = this._receivedSize;
      this.onProgress(pct, this._receivedSize, speed, this._expectedSize);
    };

    ch.onopen = () => {
      this.onStatus('Connected — ready to receive…', 'connect');
      this._startHeartbeat();
    };

    ch.onerror = (e) => {
      console.error('[Receiver channel error]', e);
      this.onStatus('⚠️ Channel error.', 'error');
    };

    ch.onclose = () => {
      this._stopHeartbeat();
      this._isTransferring = false;
      if (this._receivedSize > 0 && this._receivedSize < this._expectedSize) {
        this.onStatus('⚠️ Channel closed at ' +
          Math.round((this._receivedSize/this._expectedSize)*100) +
          '% — please retry.', 'error');
      }
    };
  }

  _assembleFile() {
    const blob = new Blob(this._chunks, { type: this._fileType });
    this._stopHeartbeat();
    this.onStatus('✓ Download ready!', 'done');
    this.onComplete(blob, this._fileName, this._expectedSize);
    this._chunks = [];
    setTimeout(() => this.destroy(), 5000);
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  _waitForICE() {
    return new Promise((resolve) => {
      if (this._pc.iceGatheringState === 'complete') { resolve(); return; }
      const t = setTimeout(resolve, 6000);
      this._pc.onicegatheringstatechange = () => {
        if (this._pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      };
    });
  }

  destroy() {
    this._stopHeartbeat();
    if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null; }
    try { if (this._channel) this._channel.close(); } catch(_) {}
    try { if (this._pc)      this._pc.close();      } catch(_) {}
    this._pc = null; this._channel = null;
  }
}

/* ── MultiSender ──────────────────────────────────────────── */
class MultiSender {
  constructor(file, { onPeerProgress, onPeerComplete, onPeerStatus, onIceCandidate }) {
    this._file           = file;
    this._onPeerProgress = onPeerProgress  || (() => {});
    this._onPeerComplete = onPeerComplete  || (() => {});
    this._onPeerStatus   = onPeerStatus    || (() => {});
    this._onIceCandidate = onIceCandidate  || (() => {});
    this._peers          = new Map();
  }

  addPeer(peerId) {
    const rtc = new ShareDropRTC({
      peerId,
      onProgress:    (pct, bytes, speed, total) => this._onPeerProgress(peerId, pct, bytes, speed, total),
      onComplete:    ()                          => this._onPeerComplete(peerId),
      onStatus:      (msg, type)                 => this._onPeerStatus(peerId, msg, type),
      onIceCandidate:(cand)                      => this._onIceCandidate(peerId, cand),
    });
    rtc.setFile(this._file);
    this._peers.set(peerId, rtc);
    return rtc;
  }

  getPeer(peerId)    { return this._peers.get(peerId); }
  removePeer(peerId) { const r = this._peers.get(peerId); if(r){r.destroy(); this._peers.delete(peerId);} }
  get peerCount()    { return this._peers.size; }
  destroyAll()       { this._peers.forEach(r => r.destroy()); this._peers.clear(); }
}

window.ShareDropRTC = ShareDropRTC;
window.MultiSender  = MultiSender;
