import { strict as assert } from "node:assert";
import test from "node:test";
import { encryptConfig, decryptConfig, isEncryptedConfig } from "../src/lib/configCrypto.ts";

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
