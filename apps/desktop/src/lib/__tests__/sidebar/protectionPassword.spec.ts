import { createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PBKDF2_ITERATIONS, hashLegacyProtectionPassword, hashProtectionPassword, isLegacyProtectionHash, isProtectionPasswordFeatureActive, parseProtectionHash, pbkdf2Sha256Pure, verifyProtectionPassword } from "@/lib/sidebar/protectionPassword";

describe("isProtectionPasswordFeatureActive", () => {
  it("is active in a plain web environment", () => {
    expect(isProtectionPasswordFeatureActive()).toBe(true);
  });

  it("is inactive under a Tauri runtime", () => {
    // `isTauriRuntime` reads `globalThis.__TAURI_INTERNALS__`, so patch the
    // real global (vitest's stubGlobal may target the DOM window instead).
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.__TAURI_INTERNALS__;
    globals.__TAURI_INTERNALS__ = {};
    try {
      expect(isProtectionPasswordFeatureActive()).toBe(false);
    } finally {
      globals.__TAURI_INTERNALS__ = previous;
    }
  });
});

describe("parseProtectionHash", () => {
  it("round-trips a generated verifier", async () => {
    const stored = await hashProtectionPassword("secret");
    const parsed = parseProtectionHash(stored);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBe(PBKDF2_ITERATIONS);
    expect(parsed!.salt.length).toBe(16);
    expect(parsed!.hash.length).toBe(32);
  });

  it.each([
    ["legacy hex digest", createHash("sha256").update("dbx-connection-group:secret").digest("hex")],
    ["garbage", "not-a-hash"],
    ["wrong part count", "pbkdf2-sha256$600000$onlysalt"],
    ["non-positive iterations", "pbkdf2-sha256$0$c2FsdA==$aGFzaA=="],
    ["empty salt", "pbkdf2-sha256$600000$$aGFzaA=="],
  ])("rejects %s", (_label, stored) => {
    expect(parseProtectionHash(stored)).toBeNull();
  });
});

describe("isLegacyProtectionHash", () => {
  it("accepts a 64-char lowercase hex digest", () => {
    expect(isLegacyProtectionHash(createHash("sha256").update("x").digest("hex"))).toBe(true);
  });

  it.each([
    ["pbkdf2 verifier", "pbkdf2-sha256$600000$c2FsdA==$aGFzaA=="],
    ["uppercase hex", createHash("sha256").update("x").digest("hex").toUpperCase()],
    ["63 chars", "a".repeat(63)],
    ["empty string", ""],
  ])("rejects %s", (_label, stored) => {
    expect(isLegacyProtectionHash(stored)).toBe(false);
  });
});

describe("pbkdf2Sha256Pure", () => {
  it.each([
    ["password", "salt", 2, 32],
    ["password", "salt", 3, 64],
    ["pässwörd", "sälting", 5, 48],
  ])("matches node:crypto for password=%j salt=%j iterations=%i bytes=%i", (password, salt, iterations, keyBytes) => {
    const expected = pbkdf2Sync(password, salt, iterations, keyBytes, "sha256");
    const actual = pbkdf2Sha256Pure(new TextEncoder().encode(password), new TextEncoder().encode(salt), iterations, keyBytes);
    expect(Buffer.from(actual).toString("hex")).toBe(expected.toString("hex"));
  });

  it("rejects a non-positive iteration count", () => {
    expect(() => pbkdf2Sha256Pure(new Uint8Array([1]), new Uint8Array([2]), 0, 32)).toThrow();
  });
});

describe("hashProtectionPassword / verifyProtectionPassword", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const stored = await hashProtectionPassword("correct horse");
    await expect(verifyProtectionPassword("correct horse", stored)).resolves.toBe(true);
    await expect(verifyProtectionPassword("wrong", stored)).resolves.toBe(false);
  });

  it("uses a fresh random salt per item", async () => {
    const [a, b] = await Promise.all([hashProtectionPassword("same"), hashProtectionPassword("same")]);
    expect(a).not.toBe(b);
    expect(parseProtectionHash(a)!.salt).not.toEqual(parseProtectionHash(b)!.salt);
  });

  it("interoperates with a verifier produced by another PBKDF2 implementation", async () => {
    const salt = Buffer.from("0123456789abcdef");
    const derived = pbkdf2Sync("pw", salt, 2, 32, "sha256");
    const stored = `pbkdf2-sha256$2$${salt.toString("base64")}$${derived.toString("base64")}`;
    await expect(verifyProtectionPassword("pw", stored)).resolves.toBe(true);
    await expect(verifyProtectionPassword("nope", stored)).resolves.toBe(false);
  });

  it("returns false for malformed stored values instead of throwing", async () => {
    await expect(verifyProtectionPassword("pw", "garbage")).resolves.toBe(false);
  });
});

describe("legacy verifier compatibility and lazy migration", () => {
  it("produces the legacy sha256(domain prefix + password) digest", async () => {
    const legacy = await hashLegacyProtectionPassword("secret");
    const expected = createHash("sha256").update("dbx-connection-group:secret").digest("hex");
    expect(legacy).toBe(expected);
    expect(isLegacyProtectionHash(legacy)).toBe(true);
  });

  it("accepts a legacy digest without a persister", async () => {
    const legacy = await hashLegacyProtectionPassword("secret");
    await expect(verifyProtectionPassword("secret", legacy)).resolves.toBe(true);
    await expect(verifyProtectionPassword("wrong", legacy)).resolves.toBe(false);
  });

  it("migrates a matching legacy digest to the salted format via the persister", async () => {
    const legacy = await hashLegacyProtectionPassword("secret");
    const persister = vi.fn().mockResolvedValue(undefined);
    await expect(verifyProtectionPassword("secret", legacy, persister)).resolves.toBe(true);
    expect(persister).toHaveBeenCalledTimes(1);
    const upgraded = persister.mock.calls[0][0] as string;
    expect(upgraded.startsWith("pbkdf2-sha256$")).toBe(true);
    // The migrated verifier must itself verify (and be a salted format now).
    await expect(verifyProtectionPassword("secret", upgraded)).resolves.toBe(true);
  });

  it("does not migrate on a wrong password", async () => {
    const legacy = await hashLegacyProtectionPassword("secret");
    const persister = vi.fn();
    await expect(verifyProtectionPassword("wrong", legacy, persister)).resolves.toBe(false);
    expect(persister).not.toHaveBeenCalled();
  });

  it("still unlocks when the persister fails", async () => {
    const legacy = await hashLegacyProtectionPassword("secret");
    const persister = vi.fn().mockRejectedValue(new Error("persist failed"));
    await expect(verifyProtectionPassword("secret", legacy, persister)).resolves.toBe(true);
  });
});
