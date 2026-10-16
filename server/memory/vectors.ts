/**
 * Vetores de embedding: normalização, (de)serialização Float32 ↔ BLOB, produto interno
 * e um cache LRU (por orçamento de bytes) dos vetores já carregados do banco.
 */

/** Normaliza para norma 1 (cosseno vira produto interno). Retorna null para vetor nulo/inválido. */
export function normalizeVector(values: ArrayLike<number>): Float32Array | null {
  const out = new Float32Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
    norm += v * v;
  }
  if (norm === 0 || out.length === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Float32Array → BLOB (cópia, little-endian). */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

/** BLOB → Float32Array (copia para garantir alinhamento). Null se o BLOB for inválido. */
export function blobToVector(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const out = new Float32Array(blob.byteLength / 4);
  new Uint8Array(out.buffer).set(blob);
  return out;
}

/** Produto interno; 0 se as dimensões não baterem. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cache LRU de vetores limitado por bytes. Chaves incluem o modelo para evitar mistura de espaços. */
export class VectorCache {
  private readonly map = new Map<string, Float32Array>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.map.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get(key: string): Float32Array | undefined {
    const v = this.map.get(key);
    if (v) {
      // Reinsere para marcar como usado mais recentemente.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, vec: Float32Array): void {
    const prev = this.map.get(key);
    if (prev) {
      this.bytes -= prev.byteLength;
      this.map.delete(key);
    }
    if (vec.byteLength > this.maxBytes) return;
    this.map.set(key, vec);
    this.bytes += vec.byteLength;
    while (this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const prev = this.map.get(key);
    if (prev) {
      this.bytes -= prev.byteLength;
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

const cacheMb = Number(process.env.LARK_VECTOR_CACHE_MB);
/** Cache global (padrão 256 MB ≈ 85 mil vetores de 768 dimensões). */
export const vectorCache = new VectorCache((Number.isFinite(cacheMb) && cacheMb > 0 ? cacheMb : 256) * 1024 * 1024);

export const vectorKey = (model: string, type: 'memory' | 'message', seq: number): string => `${model}|${type}|${seq}`;
