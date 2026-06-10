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
export const CONFIG_CRYPTO_UNAVAILABLE = "crypto_unavailable";

function getCrypto(): Crypto {
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.getRandomValues || !runtimeCrypto.subtle) {
    throw new Error(CONFIG_CRYPTO_UNAVAILABLE);
  }
  return runtimeCrypto;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error(CONFIG_CRYPTO_UNAVAILABLE);
  return subtle;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const subtle = getSubtleCrypto();
  const baseKey = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function toBase64(data: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptConfig(json: string, passphrase: string): Promise<EncryptedPayload> {
  const runtimeCrypto = getCrypto();
  const salt = runtimeCrypto.getRandomValues(new Uint8Array(16));
  const iv = runtimeCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encoded = new TextEncoder().encode(json);
  const ciphertext = await runtimeCrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
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
  let key: CryptoKey;
  try {
    key = await deriveKey(passphrase, salt);
  } catch (error) {
    if (error instanceof Error && error.message === CONFIG_CRYPTO_UNAVAILABLE) {
      const { isTauriRuntime } = await import("@/lib/tauriRuntime");
      if (!isTauriRuntime(globalThis)) {
        const { decryptConfig: decryptConfigOnBackend } = await import("@/lib/api");
        return decryptConfigOnBackend(payload, passphrase);
      }
    }
    throw error;
  }
  try {
    const plaintext = await getSubtleCrypto().decrypt({ name: "AES-GCM", iv }, key, ciphertext);
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
