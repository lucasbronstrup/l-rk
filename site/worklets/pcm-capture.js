/**
 * Lärk — AudioWorklet de captura do microfone.
 *
 * Converte o áudio do contexto (normalmente 44,1 ou 48 kHz, possivelmente estéreo) em
 * PCM16 little-endian, mono, na taxa de destino (padrão 16 kHz), em blocos de ~40 ms.
 *
 * Pipeline: mixagem para mono → filtro passa-baixa Butterworth de 4ª ordem (anti-aliasing,
 * só quando há redução de taxa) → reamostragem por interpolação linear com posição
 * fracionária contínua entre blocos → quantização para Int16.
 *
 * Mensagens recebidas pela porta: { type: 'flush' } envia o bloco parcial; { type: 'stop' } encerra.
 * Mensagens enviadas: ArrayBuffer transferível com o PCM16 de cada bloco.
 */

class Biquad {
  constructor(fs, fc, q) {
    const w0 = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Filtra o bloco no lugar (forma direta II transposta). */
  process(buf, n) {
    let z1 = this.z1;
    let z2 = this.z2;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    // Evita valores desnormalizados em silêncio prolongado.
    this.z1 = Math.abs(z1) < 1e-20 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-20 ? 0 : z2;
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    const chunkMs = opts.chunkMs || 40;
    this.chunkSamples = Math.max(160, Math.round((this.targetRate * chunkMs) / 1000));
    // `sampleRate` é global no AudioWorkletGlobalScope (taxa real do contexto).
    this.step = sampleRate / this.targetRate;
    this.out = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
    this.pos = 0;
    this.prev = 0;
    this.mono = new Float32Array(128);
    this.active = true;

    this.filters = [];
    if (this.step > 1.0001) {
      const fc = Math.min(this.targetRate * 0.45, sampleRate * 0.45);
      // Butterworth de 4ª ordem = duas seções biquad com Q 0,5412 e 1,3066.
      this.filters.push(new Biquad(sampleRate, fc, 0.5412), new Biquad(sampleRate, fc, 1.3066));
    }

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'flush') this.flush();
      else if (msg.type === 'stop') {
        this.flush();
        this.active = false;
      }
    };
  }

  flush() {
    if (this.outIndex === 0) return;
    const chunk = this.out.slice(0, this.outIndex);
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.out = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
  }

  push(sample) {
    const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.out[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.outIndex === this.chunkSamples) {
      const full = this.out;
      this.port.postMessage(full.buffer, [full.buffer]);
      this.out = new Int16Array(this.chunkSamples);
      this.outIndex = 0;
    }
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    const n = input[0].length;
    if (this.mono.length < n) this.mono = new Float32Array(n);
    const mono = this.mono;
    const channels = input.length;
    if (channels === 1) {
      mono.set(input[0]);
    } else {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += input[c][i];
        mono[i] = sum / channels;
      }
    }

    for (const f of this.filters) f.process(mono, n);

    // Interpolação linear: índice -1 representa a última amostra do bloco anterior.
    let t = this.pos;
    const step = this.step;
    while (t < n - 1) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i < 0 ? this.prev : mono[i];
      const b = mono[i + 1];
      this.push(a + (b - a) * frac);
      t += step;
    }
    this.pos = t - n;
    this.prev = mono[n - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
