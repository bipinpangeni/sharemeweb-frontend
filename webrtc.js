'use strict';

const CHUNK_SIZE       = 512 * 1024;
const BUFFER_THRESHOLD = 16 * 1024 * 1024;
const BUFFER_LOW       = 4  * 1024 * 1024;
const PREFETCH_COUNT   = 4;

/* ✅ FIXED ICE CONFIG */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // ⚠️ REPLACE THESE WITH REAL TURN CREDS
  {
    urls: 'turn:a.relay.metered.ca:80',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_PASSWORD',
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

    this._pc = null;
    this._channel = null;

    this._file = null;
    this._chunks = [];
    this._expectedSize = 0;
    this._receivedSize = 0;

    this._offset = 0;
    this._sending = false;
    this._paused = false;
  }

  /* ✅ FIXED PEER CREATION */
  _createPeer() {
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceTransportPolicy: 'all',
      bundlePolicy: 'balanced', // ✅ FIXED
    });

    /* ✅ DO NOT OVERWRITE THIS AGAIN */
    pc.onicecandidate = (e) => {
      if (e.candidate) this.onIceCandidate(e.candidate);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;

      if (s === 'connected') {
        this.onStatus('✅ Connected!', 'connect');
      }

      if (s === 'failed') {
        this.onStatus('❌ Connection failed. Retrying...', 'error');
        setTimeout(() => this.destroy(), 2000);
      }
    };

    return pc;
  }

  setFile(file) {
    this._file = file;
  }

  /* =========================
     ✅ SENDER
  ========================== */

  async createOffer() {
    this._pc = this._createPeer();

    this._channel = this._pc.createDataChannel('file-transfer');
    this._channel.binaryType = 'arraybuffer';

    this._setupSenderChannel(this._channel);

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    await this._waitForICE();
    return this._pc.localDescription;
  }

  async handleAnswer(answer) {
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /* =========================
     ✅ RECEIVER FIXED
  ========================== */

  async createReceiverOffer() {
    this._pc = this._createPeer();

    // ✅ CRITICAL FIX: create dummy channel BEFORE offer
    this._pc.createDataChannel('file-transfer');

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

  async createAnswer(offer) {
    this._pc = this._createPeer();

    this._pc.ondatachannel = (e) => {
      this._channel = e.channel;
      this._setupReceiverChannel(this._channel);
    };

    await this._pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);

    await this._waitForICE();
    return this._pc.localDescription;
  }

  async addIceCandidate(candidate) {
    try {
      await this._pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn(e);
    }
  }

  /* =========================
     ✅ SENDER CHANNEL
  ========================== */

  _setupSenderChannel(ch) {
    ch.onopen = () => {
      this.onStatus('Sending file...', 'transfer');
      this._startSend();
    };

    ch.onbufferedamountlow = () => {
      if (this._paused) {
        this._paused = false;
        this._startSend();
      }
    };
  }

  async _startSend() {
    if (!this._file || this._sending) return;

    this._sending = true;

    const file = this._file;
    const total = file.size;

    if (this._offset === 0) {
      this._channel.send(JSON.stringify({
        type: 'meta',
        name: file.name,
        size: file.size,
      }));
    }

    while (this._offset < total) {
      if (this._channel.bufferedAmount > BUFFER_THRESHOLD) {
        this._paused = true;
        this._sending = false;
        return;
      }

      const chunk = await file
        .slice(this._offset, this._offset + CHUNK_SIZE)
        .arrayBuffer();

      this._channel.send(chunk);
      this._offset += chunk.byteLength;

      const pct = Math.round((this._offset / total) * 100);
      this.onProgress(pct);
    }

    this._channel.send(JSON.stringify({ type: 'end' }));

    this.onStatus('✅ File sent!', 'done');
    this.onComplete();
  }

  /* =========================
     ✅ RECEIVER CHANNEL
  ========================== */

  _setupReceiverChannel(ch) {
    this._chunks = [];

    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);

        if (msg.type === 'meta') {
          this._expectedSize = msg.size;
          this.onFileInfo(msg.name, msg.size);
        }

        if (msg.type === 'end') {
          this._assembleFile();
        }

        return;
      }

      this._chunks.push(e.data);
      this._receivedSize += e.data.byteLength;

      const pct = Math.round(
        (this._receivedSize / this._expectedSize) * 100
      );

      this.onProgress(pct);
    };
  }

  _assembleFile() {
    const blob = new Blob(this._chunks);

    this.onStatus('✅ Download ready!', 'done');
    this.onComplete(blob);
  }

  /* =========================
     ✅ ICE FIXED (NO OVERRIDE)
  ========================== */

  _waitForICE() {
    return new Promise((resolve) => {
      if (this._pc.iceGatheringState === 'complete') return resolve();

      const check = () => {
        if (this._pc.iceGatheringState === 'complete') {
          this._pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };

      this._pc.addEventListener('icegatheringstatechange', check);

      setTimeout(resolve, 3000);
    });
  }

  destroy() {
    if (this._channel) this._channel.close();
    if (this._pc) this._pc.close();
  }
}

window.ShareDropRTC = ShareDropRTC;
