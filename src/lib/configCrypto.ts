export interface EncryptedPayload {
  format: "dbx-encrypted";
  version: 1;
  salt: string;
  iv: string;
  data: string;
}

export interface PlainConfigPayload {
  format: "dbx-config";
  version: 1;
  connections: unknown[];
}

const PBKDF2_ITERATIONS = 100_000;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptConfig(json: string, passphrase: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encoded = new TextEncoder().encode(json);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    format: "dbx-encrypted",
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  };
}

export async function decryptConfig(payload: EncryptedPayload, passphrase: string): Promise<string> {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.data);
  const key = await deriveKey(passphrase, salt);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("wrong_passphrase");
  }
}

export function isEncryptedConfig(data: unknown): data is EncryptedPayload {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.format === "dbx-encrypted" && obj.version === 1 && typeof obj.salt === "string" && typeof obj.iv === "string" && typeof obj.data === "string";
}
