import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const win7StaticPath = new URL("vendor/webview2-com-sys/win7/x64/WebView2LoaderStatic.lib", root);
const win7DllPath = new URL("vendor/webview2-com-sys/win7/x64/WebView2Loader.dll", root);
const win7StaticSha256 = "aa5c26670f1b18d0fa2a56ac3f1ae30110c332a8bfbd555a7be3e548d1b0da3d";
const win7DllSha256 = "fdf978ba706578b05967d7f0181f462147864a5aa74f36016a62cb3d3dbe6909";

function text(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function sha256(url) {
  return createHash("sha256").update(readFileSync(url)).digest("hex");
}

// A replaced loader once shipped a binary that failed on Server 2012 R2. Pin the
// committed bytes so a PR cannot swap them without an explicit hash update.
test("the vendored Windows 7 WebView2 loader matches the pinned SHA256", () => {
  assert.equal(sha256(win7StaticPath), win7StaticSha256);
  assert.equal(sha256(win7DllPath), win7DllSha256);
});

test("build.rs pins the same Windows 7 loader SHA256", () => {
  const build = text("vendor/webview2-com-sys/build.rs");
  assert.ok(build.includes(win7StaticSha256));
  assert.ok(build.includes(win7DllSha256));
  assert.ok(build.includes('target == "x86_64-win7-windows-msvc"'));
  assert.ok(build.includes("cargo:rerun-if-changed="));
});

test("upstream WebView2 loaders are vendored for standard Windows builds", () => {
  for (const arch of ["x86", "x64", "arm64"]) {
    const staticLib = readFileSync(new URL(`vendor/webview2-com-sys/${arch}/WebView2LoaderStatic.lib`, root));
    assert.ok(staticLib.length > 0, arch);
  }
});

test("Cargo uses the vendored webview2-com-sys crate", () => {
  assert.ok(text("Cargo.toml").includes('webview2-com-sys = { path = "vendor/webview2-com-sys" }'));
});

test("the preparation script does not modify the Cargo registry", () => {
  const script = text(".github/scripts/prepare-webview2-win7-loader.ps1");
  assert.ok(script.includes("vendor/webview2-com-sys/win7/x64"));
  assert.doesNotMatch(script, /cargo metadata|cargo fetch|registry\\src|Invoke-WebRequest/);
});
