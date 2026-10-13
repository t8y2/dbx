import { useConnectionStore } from "@/stores/connectionStore";
import { useConnectionGroupPasswordPromptStore } from "@/stores/connectionGroupPasswordPromptStore";
import type { ConnectionGroup } from "@/types/database";

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Pure JS SHA-256 fallback for non-secure contexts (HTTP over LAN IP).
 * crypto.subtle is only available in secure contexts (HTTPS / localhost),
 * so we need this fallback when accessing via LAN IP.
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

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    return toHex(await subtle.digest("SHA-256", data));
  }
  // Fallback for non-secure contexts (HTTP over LAN IP)
  return toHex(sha256Pure(data));
}

export async function hashConnectionGroupPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`dbx-connection-group:${password}`);
  return sha256(data);
}

export async function verifyConnectionGroupPassword(password: string, passwordHash: string): Promise<boolean> {
  const hash = await hashConnectionGroupPassword(password);
  return hash === passwordHash;
}

export async function promptConnectionGroupUnlock(group: ConnectionGroup): Promise<boolean> {
  if (!group.passwordHash) return true;
  const connectionStore = useConnectionStore();
  if (connectionStore.isConnectionGroupUnlocked(group.id)) return true;
  const promptStore = useConnectionGroupPasswordPromptStore();
  const unlocked = await promptStore.requestPassword({
    groupId: group.id,
    groupName: group.name,
    verify: (password) => verifyConnectionGroupPassword(password, group.passwordHash!),
  });
  if (!unlocked) return false;
  connectionStore.unlockConnectionGroup(group.id);
  return true;
}
