import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { sanitizeConnectionCredentials, stripInvisibleCharacters, stripInvisibleCharactersFromLayer } from "../../apps/desktop/src/lib/connection/credentialSanitizer.ts";
import type { TransportLayerConfig } from "../../apps/desktop/src/types/database.ts";

describe("stripInvisibleCharacters", () => {
  it("strips zero-width characters that survive trim()", () => {
    // U+200B ZERO WIDTH SPACE, U+FEFF BOM: invisible but not whitespace, so
    // trim() keeps them and the stored secret silently differs from the typed
    // one (#9043).
    assert.equal(stripInvisibleCharacters("secret\u200B"), "secret");
    assert.equal(stripInvisibleCharacters("\uFEFFsecret"), "secret");
    assert.equal(stripInvisibleCharacters("se\u200Ccre\u200Dt"), "secret");
    assert.equal(stripInvisibleCharacters("se\u2060cret"), "secret");
  });

  it("strips direction marks, soft hyphen, and invisible operators", () => {
    assert.equal(stripInvisibleCharacters("secret\u200E"), "secret");
    assert.equal(stripInvisibleCharacters("se\u200Fcret"), "secret");
    assert.equal(stripInvisibleCharacters("\u202Asecret\u202C"), "secret");
    assert.equal(stripInvisibleCharacters("se\u202Ecret"), "secret");
    assert.equal(stripInvisibleCharacters("se\u2066cre\u2069t"), "secret");
    assert.equal(stripInvisibleCharacters("se\u00ADcret"), "secret");
    assert.equal(stripInvisibleCharacters("se\u2061cre\u2064t"), "secret");
  });

  it("keeps meaningful characters, including whitespace and special symbols", () => {
    assert.equal(stripInvisibleCharacters("p@ss & !word *^#"), "p@ss & !word *^#");
    assert.equal(stripInvisibleCharacters(" leading and trailing "), " leading and trailing ");
    assert.equal(stripInvisibleCharacters("tab\tinside"), "tab\tinside");
    // NBSP is a legitimate password character, not a format character.
    assert.equal(stripInvisibleCharacters("nb\u00A0sp"), "nb\u00A0sp");
  });

  it("passes through undefined and empty strings", () => {
    assert.equal(stripInvisibleCharacters(undefined), undefined);
    assert.equal(stripInvisibleCharacters(""), "");
    assert.equal(stripInvisibleCharacters("\u200B"), "");
  });
});

describe("stripInvisibleCharactersFromLayer", () => {
  it("strips ssh user, password, and key passphrase", () => {
    const layer = { type: "ssh", id: "1", host: "h", port: 22, user: "ro\u200Bot", password: "p\u2060w", key_passphrase: "k\uFEFFey" } as TransportLayerConfig;
    stripInvisibleCharactersFromLayer(layer);
    assert.equal(layer.type === "ssh" && layer.user, "root");
    assert.equal(layer.type === "ssh" && layer.password, "pw");
    assert.equal(layer.type === "ssh" && layer.key_passphrase, "key");
  });

  it("strips proxy username and password", () => {
    const layer = { type: "proxy", id: "2", host: "h", port: 1080, username: "u\u200Eser", password: "p\u202Aw" } as TransportLayerConfig;
    stripInvisibleCharactersFromLayer(layer);
    assert.equal(layer.type === "proxy" && layer.username, "user");
    assert.equal(layer.type === "proxy" && layer.password, "pw");
  });

  it("strips http tunnel token", () => {
    const layer = { type: "http_tunnel", id: "3", url: "http://h", token: "to\u2069ken" } as TransportLayerConfig;
    stripInvisibleCharactersFromLayer(layer);
    assert.equal(layer.type === "http_tunnel" && layer.token, "token");
  });
});

describe("sanitizeConnectionCredentials", () => {
  it("strips top-level and transport-layer credentials in place", () => {
    const config = {
      username: "ad\u200Bmin",
      password: "se\u00ADcret",
      transport_layers: [
        { type: "ssh", id: "1", host: "h", port: 22, user: "ro\u200Eot", password: "ssh\u2060pw", key_passphrase: undefined },
        { type: "proxy", id: "2", host: "h", port: 1080, username: "pr\u202Eoxy", password: "ppw" },
        { type: "http_tunnel", id: "3", url: "http://h", token: "tk\uFEFFn" },
      ] as TransportLayerConfig[],
    };
    sanitizeConnectionCredentials(config);
    assert.equal(config.username, "admin");
    assert.equal(config.password, "secret");
    assert.equal(config.transport_layers?.[0].type === "ssh" && config.transport_layers[0].user, "root");
    assert.equal(config.transport_layers?.[0].type === "ssh" && config.transport_layers[0].password, "sshpw");
    assert.equal(config.transport_layers?.[1].type === "proxy" && config.transport_layers[1].username, "proxy");
    assert.equal(config.transport_layers?.[2].type === "http_tunnel" && config.transport_layers[2].token, "tkn");
  });

  it("leaves configs without credentials or layers untouched", () => {
    const config: { username?: string; password?: string; transport_layers?: TransportLayerConfig[] } = {};
    sanitizeConnectionCredentials(config);
    assert.equal(config.username, undefined);
    assert.equal(config.password, undefined);
    assert.equal(config.transport_layers, undefined);
  });
});
