/**
 * webrtc.js — ShareMeWeb WebRTC Engine v3 TURBO
 * ─────────────────────────────────────────────────────────────
 * Speed optimizations in v3:
 *  - 512 KB chunks (2x bigger than v2)
 *  - Pre-read chunks into memory before sending (no await bottleneck)
 *  - 16 MB buffer threshold (maximum pipeline)
 *  - Parallel chunk pre-loading
 *  - Optimized ICE configuration
 *  - Direct ArrayBuffer — no FileReader overhead
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const CHUNK_SIZE       = 512 * 1024;       // 512 KB chunks
const BUFFER_THRESHOLD = 16 * 1024 * 1024; // 16 MB buffer max
const BUFFER_LOW       = 4  * 1024 * 1024; // Resume at 4 MB
const PREFETCH_COUNT   = 4;                // Pre-read 4 chunks ahead

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'      },
  { urls: 'stun:stun1.l.google.com:19302'     },
  { urls: 'stun:stun2.l.google.com:19302'     },
  { urls: 'stun:stun3.l.google.com:19302'     },
  { urls: 'stun:stun4.l.google.com:19302'     },
  { urls: 'stun:global.stun.twilio.com:3478'  },
  { urls: 'stun:stun.cloudflare.com:3478'     },
];

class ShareDropRTC {
  constructor(opts = {}) {
    this.onProgress     = opts.onProgress     || (() => {});
    this.onComplete     = opts.onComplete     || (() => {});
    this.onStatus       = opts.onStatus       || (() => {});
    this.onFileInfo     = opts.onFileInfo     || (() => {});
    this.onIceCandidate = opts.onIceCandidate || (() => {});
    this.peerId         = opts.peerId         || 'peer';

    this._pc            = null;
    this._channel       = null;
    this._file          = null;
    this._chunks        = [];
    this._expectedSize  = 0;
    this._receivedSize  = 0;
    this._fileName      = '';
    this._fileType      = '';
    this._startTime     = 0;
    this._lastTime      = 0;
    this._lastBytes     = 0;
    this._paused        = false;
    this._sending       = false;
    this._offset        = 0;         // current send position
    this._prefetched    = [];        // pre-read buffers queue
  }

  /* ── Create peer connection ────────────────────────────────── */
  _createPeer() {
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) this.onIceCandidate(e.candidate);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected')    this.onStatus('Peer connected!', 'connect');
      if (s === 'disconnected') this.onStatus('Peer disconnected.', 'error');
      if (s === 'failed')       this.onStatus('Connection failed. Please retry.', 'error');
    };

    return pc;
  }

  /* ═══════════════════════════════════════════════════════════
     SENDER SIDE
     ═══════════════════════════════════════════════════════════ */
  setFile(file) { this._file = file; }

  async createOffer() {
    this._pc = this._createPeer();

    // Create data channel with max performance settings
    this._channel = this._pc.createDataChannel('file-transfer', {
      ordered:    true,
      maxRetransmits: null,
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

  /* Sender answers receiver-first offer */
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
    catch(e) { console.warn('ICE:', e.message); }
  }

  /* ── Sender channel setup ──────────────────────────────────── */
  _setupSenderChannel(ch) {
    ch.onopen = () => {
      this.onStatus('Connected — sending file at max speed…', 'transfer');
      this._startTurboSend();
    };

    // Resume immediately when buffer drains
    ch.onbufferedamountlow = () => {
      if (this._paused) {
        this._paused  = false;
        this._sending = false;
        this._startTurboSend();
      }
    };

    ch.onerror = () => this.onStatus('Channel error.', 'error');
    ch.onclose = () => this.onStatus('Channel closed.', 'waiting');
  }

  /* ── TURBO SEND — pre-fetch + pipeline ─────────────────────── */
  async _startTurboSend() {
    if (!this._file || !this._channel || this._sending) return;
    this._sending   = true;
    this._offset    = this._offset || 0;

    const file      = this._file;
    const totalSize = file.size;

    // Send metadata
    if (this._offset === 0) {
      this._channel.send(JSON.stringify({
        type:     'meta',
        name:     file.name,
        size:     file.size,
        mimeType: file.type || 'application/octet-stream',
      }));
      this._startTime = Date.now();
      this._lastTime  = this._startTime;
      this._lastBytes = 0;
    }

    // Pre-fetch next chunks into memory while sending current ones
    while (this._offset < totalSize) {

      // Back-pressure — buffer is full, pause and wait
      if (this._channel.bufferedAmount > BUFFER_THRESHOLD) {
        this._paused  = true;
        this._sending = false;
        return;
      }

      // Pre-fetch PREFETCH_COUNT chunks in parallel
      const fetchPromises = [];
      for (let i = 0; i < PREFETCH_COUNT; i++) {
        const start = this._offset + (i * CHUNK_SIZE);
        if (start >= totalSize) break;
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        fetchPromises.push(file.slice(start, end).arrayBuffer());
      }

      // Wait for all pre-fetched chunks
      const buffers = await Promise.all(fetchPromises);

      // Send all pre-fetched chunks rapidly
      for (const buffer of buffers) {
        if (!this._channel || this._channel.readyState !== 'open') return;

        this._channel.send(buffer);
        this._offset += buffer.byteLength;

        // Update progress
        const pct   = Math.round((this._offset / totalSize) * 100);
        const now   = Date.now();
        const dt    = Math.max((now - this._lastTime) / 1000, 0.001);
        const speed = (this._offset - this._lastBytes) / dt;
        this._lastTime  = now;
        this._lastBytes = this._offset;
        this.onProgress(pct, this._offset, speed, totalSize);
      }
    }

    // All sent!
    this._channel.send(JSON.stringify({ type: 'end' }));
    this._sending = false;
    this._offset  = 0;
    this.onStatus('✓ File sent successfully!', 'done');
    this.onComplete();
  }

  /* ═══════════════════════════════════════════════════════════
     RECEIVER SIDE
     ═══════════════════════════════════════════════════════════ */
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

  /* ── Receiver channel — fast chunk assembly ─────────────────── */
  _setupReceiverChannel(ch) {
    this._chunks       = [];
    this._receivedSize = 0;

    // Use larger internal buffer for faster receipt
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'meta') {
          this._fileName     = msg.name;
          this._fileType     = msg.mimeType;
          this._expectedSize = msg.size;
          this._startTime    = Date.now();
          this._lastTime     = this._startTime;
          this._lastBytes    = 0;
          this.onFileInfo(msg.name, msg.size);
          this.onStatus('Receiving: ' + msg.name, 'transfer');
        }
        if (msg.type === 'end') this._assembleFile();
        return;
      }

      // Binary chunk — store directly
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

    ch.onopen  = () => this.onStatus('Connected — ready to receive…', 'connect');
    ch.onerror = () => this.onStatus('Channel error.', 'error');
  }

  _assembleFile() {
    const blob = new Blob(this._chunks, { type: this._fileType });
    this.onStatus('✓ Download ready!', 'done');
    this.onComplete(blob, this._fileName, this._expectedSize);
    this._chunks = [];
    setTimeout(() => this.destroy(), 5000);
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  _waitForICE() {
    return new Promise((resolve) => {
      if (this._pc.iceGatheringState === 'complete') { resolve(); return; }
      const t = setTimeout(resolve, 4000);
      this._pc.onicegatheringstatechange = () => {
        if (this._pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      };
    });
  }

  destroy() {
    try { if (this._channel) this._channel.close(); } catch(_) {}
    try { if (this._pc)      this._pc.close();      } catch(_) {}
    this._pc = null; this._channel = null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   MultiSender — one file → N receivers simultaneously
   ═══════════════════════════════════════════════════════════════ */
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
