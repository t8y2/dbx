import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./configure-ubuntu-apt.py", import.meta.url));

test("runner mirror lists use the primary archive while preserving priorities and security fallback", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "dbx-apt-mirrors-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "sources.list.d"));
  const source = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
  const mirrors = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
  writeFileSync(path.join(root, "sources.list.d/ubuntu.sources"), source);
  writeFileSync(path.join(root, "apt-mirrors.txt"), mirrors);
  const result = spawnSync("python3", [script, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(root, "apt-mirrors.txt"), "utf8"), "https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n");
  assert.equal(readFileSync(path.join(root, "sources.list.d/ubuntu.sources"), "utf8"), source);
  const repeated = spawnSync("python3", [script, root], { encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, "");
});

test("Ubuntu archive selection supports legacy and deb822 sources without changing other repositories", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "dbx-apt-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "sources.list.d"));
  const fixtures = {
    "sources.list": "deb http://azure.archive.ubuntu.com/ubuntu noble main\n",
    "sources.list.d/ubuntu.list": "deb https://azure.archive.ubuntu.com/ubuntu/ noble-updates main\n",
    "sources.list.d/ubuntu.sources": "Types: deb\r\nURIs: http://azure.archive.ubuntu.com/ubuntu\r\nSuites: noble noble-updates\r\nComponents: main universe\r\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n",
    "sources.list.d/other.sources": "URIs: http://security.ubuntu.com/ubuntu https://archive.ubuntu.com/ubuntu https://packages.example.test/ubuntu https://azure.archive.ubuntu.com/ubuntu-other\n",
    "sources.list.d/ubuntu.sources.save": "URIs: http://azure.archive.ubuntu.com/ubuntu\n",
  };
  for (const [name, content] of Object.entries(fixtures)) writeFileSync(path.join(root, name), content);
  const result = spawnSync("python3", [script, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const [name, content] of Object.entries(fixtures)) {
    const expected = name.startsWith("sources.list.d/other") || name.endsWith(".save") ? content : content.replace(/https?:\/\/azure\.archive\.ubuntu\.com/g, "https://archive.ubuntu.com");
    assert.equal(readFileSync(path.join(root, name), "utf8"), expected, name);
  }
  const repeated = spawnSync("python3", [script, root], { encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, "", "already configured sources should not be rewritten");
});
