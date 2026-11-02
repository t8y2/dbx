import type { TransportLayerConfig } from "@/types/database";

// Zero-width and other invisible characters (U+200B ZERO WIDTH SPACE,
// U+200C/ZWNJ, U+200D/ZWJ, U+2060 WORD JOINER, U+FEFF BOM) can ride along when
// a credential is pasted from web pages or rich-text sources. They survive
// String.trim() — not ASCII whitespace — and turn a visually identical
// password into a different secret, so the connection fails with "incorrect
// username/password" (#9043). Strip them from credential fields before save.
// The set also covers direction marks (U+200E/U+200F, U+202A–U+202E,
// U+2066–U+2069), the soft hyphen U+00AD, and the invisible operators
// U+2061–U+2064. NBSP (U+00A0) and ASCII whitespace are deliberately kept:
// they are legitimate password characters.
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function stripInvisibleCharacters(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(INVISIBLE_CHARACTERS, "");
}

/** Strips invisible characters from the credential fields of one transport layer, in place. */
export function stripInvisibleCharactersFromLayer(layer: TransportLayerConfig): void {
  if (layer.type === "ssh") {
    layer.user = stripInvisibleCharacters(layer.user) ?? layer.user;
    layer.password = stripInvisibleCharacters(layer.password);
    layer.key_passphrase = stripInvisibleCharacters(layer.key_passphrase);
  } else if (layer.type === "proxy") {
    layer.username = stripInvisibleCharacters(layer.username) ?? layer.username;
    layer.password = stripInvisibleCharacters(layer.password);
  } else {
    layer.token = stripInvisibleCharacters(layer.token);
  }
}

export interface CredentialBearingConfig {
  username?: string;
  password?: string;
  transport_layers?: TransportLayerConfig[];
}

/** Strips invisible characters from the credential fields of a connection config, in place. */
export function sanitizeConnectionCredentials(config: CredentialBearingConfig): void {
  config.username = stripInvisibleCharacters(config.username) ?? config.username;
  config.password = stripInvisibleCharacters(config.password) ?? config.password;
  config.transport_layers?.forEach(stripInvisibleCharactersFromLayer);
}
