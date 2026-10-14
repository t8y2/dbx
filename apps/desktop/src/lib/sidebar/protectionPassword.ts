// Protection-password verifiers for connection groups and SQL library folders.
//
// New verifiers use PBKDF2-HMAC-SHA256 with a per-item random salt
// (`pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>`). The stored verifier is
// delivered to clients inside the sidebar layout / SQL library payloads, so it
// must resist offline brute force on its own: the random salt defeats
// precomputation across items and the PBKDF2 work factor slows down each
// guess. Legacy verifiers were plain SHA-256 over a fixed public prefix, which
// is cheaply brute-forceable in bulk — `verifyProtectionPassword` still
// accepts them and transparently re-hashes on success (lazy migration).
//
// `crypto.subtle` only exists in secure contexts (HTTPS / localhost). Access
// via a LAN IP over HTTP falls back to the pure-JS implementation below so
// the verifier format stays identical in every deployment.

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/**
 * Protection passwords are a web-only feature. The desktop build never locks,
 * prompts, or renders password UI: a local user owns the data files on disk
 * and could strip a stored verifier straight from the local database, so the
 * gate adds no protection there. Verifiers that arrive via data created in
 * the web app are simply ignored on desktop.
 */
export function isProtectionPasswordFeatureActive(): boolean {
  return !isTauriRuntime();
}

export const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;
const HASH_FORMAT_PREFIX = "pbkdf2-sha256$";
const LEGACY_DOMAIN_PREFIX = "dbx-connection-group:";
const SHA256_BLOCK_BYTES = 64;

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const index = BASE64_CHARS.indexOf(ch);
    if (index < 0) throw new Error("invalid base64 character");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqualBytes(hexToBytes(a), hexToBytes(b));
}

/**
 * Pure JS SHA-256. Required as the PBKDF2 primitive in non-secure contexts
 * (HTTP over a LAN IP) where `crypto.subtle` is unavailable.
 */
function sha256Pure(data: Uint8Array): Uint8Array {
  const K: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  // Pre-processing: pad message to 512-bit blocks
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  // Message + 1 byte (0x80) + padding + 8 bytes (length)
  const totalBlocks = Math.ceil((msgLen + 9) / 64);
  const padded = new Uint8Array(totalBlocks * 64);
  padded.set(data);
  padded[msgLen] = 0x80;
  // Append bit length as 64-bit big-endian
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 4, bitLen, false);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let block = 0; block < totalBlocks; block++) {
    const base = block * 64;
    const W = new Array<number>(64);
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(base + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rv.setUint32(i * 4, H[i], false);
  return result;
}

async function digestSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    return toHex(await subtle.digest("SHA-256", data));
  }
  // Fallback for non-secure contexts (HTTP over LAN IP)
  return toHex(sha256Pure(data));
}

function hmacSha256Pure(key: Uint8Array, message: Uint8Array): Uint8Array {
  let normalized = key;
  if (normalized.length > SHA256_BLOCK_BYTES) {
    normalized = sha256Pure(normalized);
  }
  const inner = new Uint8Array(SHA256_BLOCK_BYTES + message.length);
  const outer = new Uint8Array(SHA256_BLOCK_BYTES + 32);
  for (let i = 0; i < SHA256_BLOCK_BYTES; i++) {
    const k = i < normalized.length ? normalized[i] : 0;
    inner[i] = k ^ 0x36;
    outer[i] = k ^ 0x5c;
  }
  inner.set(message, SHA256_BLOCK_BYTES);
  outer.set(sha256Pure(inner), SHA256_BLOCK_BYTES);
  return sha256Pure(outer);
}

/**
 * Pure-JS PBKDF2-HMAC-SHA256 (RFC 2898). Slow by necessity — the work factor
 * is the point — so it is only used when `crypto.subtle` is unavailable.
 */
export function pbkdf2Sha256Pure(password: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number, keyBytes: number): Uint8Array<ArrayBuffer> {
  if (iterations <= 0) throw new Error("iterations must be positive");
  const hLen = 32;
  const blockCount = Math.ceil(keyBytes / hLen);
  const derived = new Uint8Array(blockCount * hLen);
  const counter = new Uint8Array(4);
  for (let block = 1; block <= blockCount; block++) {
    counter[0] = (block >>> 24) & 0xff;
    counter[1] = (block >>> 16) & 0xff;
    counter[2] = (block >>> 8) & 0xff;
    counter[3] = block & 0xff;
    const saltCounter = new Uint8Array(salt.length + 4);
    saltCounter.set(salt);
    saltCounter.set(counter, salt.length);
    let u = hmacSha256Pure(password, saltCounter);
    const blockBytes = Uint8Array.from(u);
    for (let round = 1; round < iterations; round++) {
      u = hmacSha256Pure(password, u);
      for (let i = 0; i < hLen; i++) {
        blockBytes[i] ^= u[i];
      }
    }
    derived.set(blockBytes, (block - 1) * hLen);
  }
  return derived.slice(0, keyBytes);
}

async function pbkdf2Sha256Subtle(password: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number, keyBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = globalThis.crypto!.subtle!;
  const key = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, keyBytes * 8);
  return new Uint8Array(bits);
}

async function deriveProtectionKey(password: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number, keyBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (globalThis.crypto?.subtle) {
    return pbkdf2Sha256Subtle(password, salt, iterations, keyBytes);
  }
  return pbkdf2Sha256Pure(password, salt, iterations, keyBytes);
}

export interface ParsedProtectionHash {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

/**
 * Parse a `pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>` verifier.
 * Returns null for anything else (including legacy hex digests).
 */
export function parseProtectionHash(stored: string): ParsedProtectionHash | null {
  if (!stored.startsWith(HASH_FORMAT_PREFIX)) return null;
  const parts = stored.split("$");
  if (parts.length !== 4) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;
  try {
    const salt = fromBase64(parts[2]);
    const hash = fromBase64(parts[3]);
    if (salt.length === 0 || hash.length === 0) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

/**
 * Legacy verifiers were plain hex SHA-256 digests over a fixed public prefix,
 * identical for groups and folders.
 */
export function isLegacyProtectionHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

function encodeProtectionHash(salt: Uint8Array, hash: Uint8Array): string {
  return `${HASH_FORMAT_PREFIX}${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Hash a protection password with a fresh random salt. Used when setting or
 * changing a group/folder password and when migrating legacy verifiers.
 */
export async function hashProtectionPassword(password: string): Promise<string> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await deriveProtectionKey(new TextEncoder().encode(password), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES);
  return encodeProtectionHash(salt, key);
}

export async function hashLegacyProtectionPassword(password: string): Promise<string> {
  return digestSha256(new TextEncoder().encode(`${LEGACY_DOMAIN_PREFIX}${password}`));
}

export type ProtectionHashUpgradePersister = (upgradedHash: string) => Promise<void> | void;

/**
 * Verify a password against its stored verifier. New-format verifiers are
 * re-derived with their own salt and iteration count; legacy digests are
 * compared for compatibility and, when `persistUpgrade` is provided,
 * transparently migrated to the salted PBKDF2 format after a successful
 * match. A failed migration never blocks the unlock.
 */
export async function verifyProtectionPassword(password: string, stored: string, persistUpgrade?: ProtectionHashUpgradePersister): Promise<boolean> {
  const passwordBytes = new TextEncoder().encode(password);
  const parsed = parseProtectionHash(stored);
  if (parsed) {
    const derived = await deriveProtectionKey(passwordBytes, parsed.salt, parsed.iterations, parsed.hash.length);
    return timingSafeEqualBytes(derived, parsed.hash);
  }
  const legacy = await digestSha256(new TextEncoder().encode(`${LEGACY_DOMAIN_PREFIX}${password}`));
  if (!timingSafeEqualHex(legacy, stored)) return false;
  if (persistUpgrade) {
    try {
      await persistUpgrade(await hashProtectionPassword(password));
    } catch {
      // Best-effort migration only.
    }
  }
  return true;
}
