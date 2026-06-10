import { strict as assert } from "node:assert";
import { test } from "vitest";
import { CONFIG_CRYPTO_UNAVAILABLE, encryptConfig, decryptConfig, isEncryptedConfig } from "../../apps/desktop/src/lib/configCrypto.ts";

test("encrypts and decrypts config round-trip", async () => {
  const original = JSON.stringify([{ id: "1", name: "test", password: "secret123" }]);
  const encrypted = await encryptConfig(original, "my-passphrase");

  assert.equal(encrypted.format, "dbx-encrypted");
  assert.equal(encrypted.version, 1);
  assert.ok(encrypted.salt);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.data);

  const decrypted = await decryptConfig(encrypted, "my-passphrase");
  assert.equal(decrypted, original);
});

test("fails to decrypt with wrong passphrase", async () => {
  const encrypted = await encryptConfig('{"test":true}', "correct-passphrase");

  await assert.rejects(
    () => decryptConfig(encrypted, "wrong-passphrase"),
    (err: Error) => err.message === "wrong_passphrase",
  );
});

test("detects encrypted config format", () => {
  assert.equal(isEncryptedConfig({ format: "dbx-encrypted", version: 1, salt: "a", iv: "b", data: "c" }), true);
  assert.equal(isEncryptedConfig({ format: "dbx-config", version: 1, connections: [] }), false);
  assert.equal(isEncryptedConfig([{ id: "1" }]), false);
  assert.equal(isEncryptedConfig(null), false);
  assert.equal(isEncryptedConfig("string"), false);
});

test("reports crypto unavailable when Web Crypto is missing", async () => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
  });

  try {
    await assert.rejects(
      () => encryptConfig("{}", "passphrase"),
      (err: Error) => err.message === CONFIG_CRYPTO_UNAVAILABLE,
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});
