/**
 * webrtc.js — ShareMeWeb WebRTC Engine v2
 * ─────────────────────────────────────────────────────────────
 * NEW in v2:
 *  - 256 KB chunks (4x faster than before)
 *  - Higher buffer threshold for sustained throughput
 *  - Multi-receiver: sender handles N simultaneous peers
 *  - Receiver-first mode: receiver generates QR, sender scans
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ── Constants ──────────────────────────────────────────────── */
const CHUNK_SIZE       = 256 * 1024;      // 256 KB per chunk (was 64KB)
const BUFFER_THRESHOLD = 4 * 1024 * 1024; // 4 MB — pause sending above this
const BUFFER_LOW       = 1 * 1024 * 1024; // 1 MB — resume when below this

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/* ═══════════════════════════════════════════════════════════════
   ShareMeWebRTC — manages ONE WebRTC peer connection
   ═══════════════════════════════════════════════════════════════ */
class ShareMeWebRTC {
  constructor(opts = {}) {
    this.onProgress     = opts.onProgress     || (() => {});
    this.onComplete     = opts.onComplete     || (() => {});
    this.onStatus       = opts.onStatus       || (() => {});
    this.onFileInfo     = opts.onFileInfo     || (() => {});
    this.onIceCandidate = opts.onIceCandidate || (() => {});
    this.peerId         = opts.peerId         || 'peer';

    this._pc           = null;
    this._channel      = null;
    this._file         = null;
    this._chunks       = [];
    this._expectedSize = 0;
    this._receivedSize = 0;
    this._fileName     = '';
    this._fileType     = '';
    this._startTime    = 0;
    this._lastTime     = 0;
    this._lastBytes    = 0;
    this._paused       = false;
    this._sending      = false;
  }

  /* ── Create RTCPeerConnection ──────────────────────────────── */
  _createPeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
     SENDER-FIRST MODE (original flow)
     Sender selects file → generates QR → receiver scans
     ═══════════════════════════════════════════════════════════ */

  setFile(file) { this._file = file; }

  /** Sender creates WebRTC offer */
  async createOffer() {
    this._pc = this._createPeer();

    this._channel = this._pc.createDataChannel('file-transfer', { ordered: true });
    this._channel.binaryType = 'arraybuffer';
    this._channel.bufferedAmountLowThreshold = BUFFER_LOW;
    this._setupSenderChannel(this._channel);

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForICE();
    return this._pc.localDescription;
  }

  /** Sender receives answer from receiver */
  async handleAnswer(answer) {
    if (!this._pc) throw new Error('No peer connection.');
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.onStatus('Receiver connected — starting transfer…', 'transfer');
  }

  /* ═══════════════════════════════════════════════════════════
     RECEIVER-FIRST MODE (new flow)
     Receiver generates QR → sender scans → sender sends file
     ═══════════════════════════════════════════════════════════ */

  /** Receiver generates offer (shows QR code) */
  async createReceiverOffer() {
    this._pc = this._createPeer();

    // Receiver waits for data channel from sender
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

  /** Sender answers the receiver's offer AND creates the data channel */
  async answerReceiverOffer(offer) {
    this._pc = this._createPeer();

    // Sender creates the data channel in receiver-first mode
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

  /** Receiver processes sender's answer (receiver-first mode) */
  async handleSenderAnswer(answer) {
    if (!this._pc) throw new Error('No peer connection.');
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.onStatus('Sender connected — waiting for file…', 'connect');
  }

  /* ═══════════════════════════════════════════════════════════
     ORIGINAL RECEIVER FLOW
     ═══════════════════════════════════════════════════════════ */

  /** Receiver answers sender's offer (sender-first mode) */
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

  /** Add remote ICE candidate */
  async addIceCandidate(candidate) {
    if (!this._pc) return;
    try { await this._pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e) { console.warn('ICE error:', e.message); }
  }

  /* ─────────────────────────────────────────────────────────────
     DATA CHANNEL — SENDER SIDE
     ───────────────────────────────────────────────────────────── */
  _setupSenderChannel(ch) {
    ch.onopen = () => {
      this.onStatus('Channel open — sending file…', 'transfer');
      this._sendFile();
    };

    // Resume sending when buffer drains below BUFFER_LOW
    ch.onbufferedamountlow = () => {
      if (this._paused) {
        this._paused  = false;
        this._sending = false;
        this._sendFile();
      }
    };

    ch.onerror = (e) => this.onStatus('Channel error.', 'error');
    ch.onclose = () => this.onStatus('Channel closed.', 'waiting');
  }

  async _sendFile() {
    if (!this._file || !this._channel || this._sending) return;
    this._sending = true;

    const file      = this._file;
    const totalSize = file.size;

    // Send file metadata as JSON
    this._channel.send(JSON.stringify({
      type:     'meta',
      name:     file.name,
      size:     file.size,
      mimeType: file.type || 'application/octet-stream',
    }));

    let offset          = 0;
    this._startTime     = Date.now();
    this._lastTime      = this._startTime;
    this._lastBytes     = 0;

    while (offset < totalSize) {
      // Back-pressure check
      if (this._channel.bufferedAmount > BUFFER_THRESHOLD) {
        this._paused  = true;
        this._sending = false;
        return; // Resumes via onbufferedamountlow
      }

      const end    = Math.min(offset + CHUNK_SIZE, totalSize);
      const slice  = file.slice(offset, end);
      const buffer = await slice.arrayBuffer();

      this._channel.send(buffer);
      offset += buffer.byteLength;

      // Update progress
      const pct   = Math.round((offset / totalSize) * 100);
      const now   = Date.now();
      const dt    = Math.max((now - this._lastTime) / 1000, 0.001);
      const speed = (offset - this._lastBytes) / dt;
      this._lastTime  = now;
      this._lastBytes = offset;

      this.onProgress(pct, offset, speed, totalSize);

      // Yield to browser event loop every 10 chunks to stay responsive
      if ((offset / CHUNK_SIZE) % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Signal end of transfer
    this._channel.send(JSON.stringify({ type: 'end' }));
    this._sending = false;
    this.onStatus('✓ File sent successfully!', 'done');
    this.onComplete();
  }

  /* ─────────────────────────────────────────────────────────────
     DATA CHANNEL — RECEIVER SIDE
     ───────────────────────────────────────────────────────────── */
  _setupReceiverChannel(ch) {
    this._chunks       = [];
    this._receivedSize = 0;

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

      // Binary chunk received
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

    ch.onopen  = () => this.onStatus('Connected — waiting for file…', 'connect');
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
   MultiSender
   Manages N simultaneous receiver connections for ONE file.
   The sender creates one ShareMeWebRTC per receiver that joins.
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

  /** Add a new receiver peer */
  addPeer(peerId) {
    const rtc = new ShareMeWebRTC({
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

window.ShareMeWebRTC = ShareMeWebRTC;
window.MultiSender  = MultiSender;
