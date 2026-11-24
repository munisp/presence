/**
 * SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) in pure TypeScript.
 *
 * Why this exists: TR-31 derives BLE rotating codes by HMAC, and Hermes
 * (the React Native runtime) ships no crypto primitives. Pulling in a
 * native crypto package would add a SEC-18 allowlist entry for one digest
 * — a self-contained implementation keeps the dependency surface flat.
 * Correctness is pinned against published vectors (RFC 4231, FIPS
 * examples) and cross-checked against node:crypto in the unit tests.
 *
 * Internal to src/presence — nothing here travels on the wire by itself.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over a byte string. One-shot; inputs here are small. */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Padding: message || 0x80 || zeros || 64-bit big-endian bit length.
  const bitLenHi = Math.floor(data.length / 0x20000000);
  const bitLenLo = (data.length * 8) >>> 0;
  const paddedLen = (((data.length + 9 + 63) >> 6) << 6) >>> 0;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi);
  dv.setUint32(paddedLen - 4, bitLenLo);

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC-SHA256 (RFC 2104) with arbitrary-length keys. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockKey = key.length > 64 ? sha256(key) : key;
  const ipad = new Uint8Array(64 + message.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const kb = i < blockKey.length ? blockKey[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  ipad.set(message, 64);
  const inner = sha256(ipad);
  opad.set(inner, 64);
  return sha256(opad);
}

/**
 * ASCII encode without depending on platform globals (Hermes does not
 * guarantee TextEncoder). The derivation inputs in this codebase are
 * ASCII by construction; anything else is a caller bug and throws.
 */
export function utf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) throw new Error("utf8(): ASCII-only input expected");
    out[i] = code;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
