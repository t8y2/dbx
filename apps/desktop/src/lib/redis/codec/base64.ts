const BASE64_TEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Strict, user-selected Base64 decode for the codec axis: returns the decoded
 * content as text, or null when the stored bytes are not clean Base64 (this is
 * deliberately not auto-detected because many plain ASCII strings decode fine
 * into garbage bytes).
 */
export function decodeBase64RedisValue(bytes: Uint8Array): string | null {
  if (typeof atob !== "function") return null;
  const source = new TextDecoder().decode(bytes).replace(/[\r\n]/g, "");
  if (!source || source.length % 4 === 1 || !BASE64_TEXT_PATTERN.test(source)) return null;
  const binary = atob(source);
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(decoded);
}
