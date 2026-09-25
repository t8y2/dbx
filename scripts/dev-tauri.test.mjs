import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { developmentArgs } from "./dev-tauri.mjs";
import { designatedRequirement, ensureSigningIdentity, loadSigningIdentity, removeSigningKeychain, signDevelopmentBinary } from "./macos-dev-signing.mjs";
import { fileURLToPath } from "node:url";

test("non-macOS development arguments are unchanged", () => {
  for (const platform of ["linux", "win32"]) {
    assert.deepEqual(developmentArgs(["--", "--no-default-features"], platform), ["dev", "--", "--no-default-features"]);
  }
});

test("both macOS targets receive a Cargo runner with space-safe paths", () => {
  const args = developmentArgs([], "darwin", "/path with spaces/node", "/repo with spaces/dev.mjs");
  assert.deepEqual(args.slice(0, 2), ["dev", "--"]);
  for (const [index, target] of [
    [3, "aarch64"],
    [5, "x86_64"],
  ]) {
    assert.equal(args[index], `target.${target}-apple-darwin.runner=["/path with spaces/node","/repo with spaces/dev.mjs","--run-signed"]`);
  }
});

test("Tauri flags, Cargo features and application arguments keep their separators", () => {
  const args = developmentArgs(["--no-watch", "--", "--no-default-features", "--features", "sqlite-bundled,os-keyring", "--", "--example"], "darwin");
  assert.deepEqual(args.slice(0, 6), ["dev", "--no-watch", "--", "--no-default-features", "--features", "sqlite-bundled,os-keyring"]);
  assert.deepEqual(args.slice(-2), ["--", "--example"]);
});

test("release builds never enter the development signing flow", () => {
  assert.throws(() => developmentArgs(["--release"], "darwin"), /release artifacts/);
  assert.deepEqual(developmentArgs(["--", "--", "--release"], "darwin").slice(-2), ["--", "--release"]);
});

test("custom Tauri runners cannot bypass development signing", () => {
  for (const args of [["-r", "custom"], ["--runner", "custom"], ["--runner=custom"]]) {
    assert.throws(() => developmentArgs(args, "darwin"), /bypass development signing/);
  }
});

test("incomplete identities are preserved instead of silently regenerated", { skip: process.platform !== "darwin" }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dbx-dev-signing-incomplete-"));
  const keychain = path.join(directory, "development.keychain-db");
  try {
    writeFileSync(keychain, "existing identity", { mode: 0o600 });
    assert.throws(() => ensureSigningIdentity(directory), /Incomplete development signing setup/);
    assert.equal(readFileSync(keychain, "utf8"), "existing identity");
    assert.equal(existsSync(path.join(directory, "setup.lock")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the designated requirement binds both the stable identifier and certificate", () => {
  const fingerprint = "AB".repeat(20);
  assert.equal(designatedRequirement(fingerprint), `identifier "com.dbx.app.development" and certificate leaf = H"${fingerprint}"`);
  for (const invalid of ["", "-", "AB", '" or true']) assert.throws(() => designatedRequirement(invalid));
});

test("signing configuration rejects symlinked directories before accessing a keychain", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "dbx-dev-signing-test-"));
  try {
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    assert.throws(() => loadSigningIdentity(path.join(root, "link")), /unsafe path/);
    assert.throws(() => ensureSigningIdentity(path.join(root, "link")), /unsafe path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "rebuilt binaries retain Keychain access without user interaction",
  {
    skip: process.platform !== "darwin" || process.env.DBX_TEST_MACOS_KEYCHAIN !== "1",
    timeout: 60000,
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "dbx-dev-signing-integration-"));
    const directory = path.join(root, "signing");
    let identity;
    const execute = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      identity = ensureSigningIdentity(directory);
      const binary = path.join(root, "probe");
      const source = fileURLToPath(new URL("./fixtures/macos-dev-keychain.c", import.meta.url));
      const compile = (version) => execute("/usr/bin/clang", ["-Wno-deprecated-declarations", `-DDBX_PROBE_VERSION=${version}`, source, "-framework", "Security", "-framework", "CoreFoundation", "-o", binary]);
      const signature = () => {
        const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", "--verbose=4", binary], { encoding: "utf8" });
        assert.equal(result.status, 0);
        const output = result.stdout + result.stderr;
        return { requirement: output.match(/designated => (.+)/)?.[1], hash: output.match(/^CDHash=(.+)$/m)?.[1] };
      };
      compile(1);
      signDevelopmentBinary(binary, directory);
      const first = signature();
      assert.match(execute(binary, [identity.keychain]), /build=1 status=0/);
      compile(2);
      const unsigned = spawnSync(binary, [identity.keychain], { encoding: "utf8" });
      assert.equal(unsigned.status, 3, "an ad-hoc rebuild must not inherit the signed program's authorization");
      signDevelopmentBinary(binary, directory);
      const second = signature();
      const searchList = execute("/usr/bin/security", ["list-keychains", "-d", "user"]);
      assert.equal([...searchList.matchAll(/"([^"\n]+)"/g)].filter((match) => match[1] === identity.keychain).length, 1);
      assert.ok(first.hash && first.requirement);
      assert.notEqual(first.hash, second.hash);
      assert.equal(first.requirement, second.requirement);
      assert.match(execute(binary, [identity.keychain]), /build=2 status=0/);
      assert.equal(ensureSigningIdentity(directory).fingerprint, identity.fingerprint);
    } finally {
      if (identity) removeSigningKeychain(identity.keychain);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
