import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { afterEach, test } from "vitest";
import { mcpIdentifier, mcpRequirement, signMcp, verifyMcp } from "../../.github/scripts/sign-mcp-macos.mjs";

const workflow = parse(readFileSync(".github/workflows/mcp-release.yml", "utf8"));

test("every macOS MCP build signs before staging and validates npm reruns", () => {
  const job = workflow.jobs["publish-mcp-platforms"];
  assert.deepEqual(job.strategy.matrix.include.filter((leg) => leg.target.endsWith("apple-darwin")).map((leg) => leg.target).sort(), [
    "aarch64-apple-darwin", "x86_64-apple-darwin",
  ]);
  const steps = job.steps;
  const build = steps.findIndex((step) => step.name === "Build Rust MCP binary");
  const sign = steps.findIndex((step) => step.run?.includes("sign-mcp-macos.mjs sign"));
  const stage = steps.findIndex((step) => step.name === "Stage platform package");
  assert.ok(sign > build && sign < stage, "MCP macOS binaries must be signed after building and before staging");
  assert.equal(steps[sign].if, "runner.os == 'macOS'");
  assert.ok(!steps[sign]["continue-on-error"]);
  assert.match(steps[stage].run, /sign-mcp-macos.mjs verify/);
  const publish = steps.find((step) => step.name === "Publish platform package").run;
  assert.ok(publish.indexOf("sign-mcp-macos.mjs verify") < publish.indexOf("exit 0"));
  assert.match(publish, /npm pack/);
});

test("standalone MCP and Homebrew use verified signed npm bytes", () => {
  const job = workflow.jobs["publish-mcp-github-release"];
  assert.match(job["runs-on"], /^macos-/);
  const pack = job.steps.find((step) => step.name === "Build native release archives from npm packages").run;
  assert.match(pack, /sign-mcp-macos.mjs verify/);
  assert.match(pack, /cmp /);
  assert.match(workflow.jobs["publish-homebrew-formula"].steps.at(-1).run, /render-mcp-formula.mjs/);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-signing-test-"));
  roots.push(root);
  const binary = join(root, "dbx-mcp");
  writeFileSync(binary, "first build");
  const state = join(root, "state.json");
  const log = join(root, "commands.jsonl");
  const settings = join(root, "config.json");
  const original = ["/Users/runner/Library/Keychains/login.keychain-db", "/a keychain/custom.keychain-db"];
  writeFileSync(state, JSON.stringify(original));
  writeFileSync(settings, JSON.stringify(config));
  const source = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const security = process.argv[1].endsWith('/security');
const config = JSON.parse(readFileSync(${JSON.stringify(settings)}, 'utf8'));
const state = ${JSON.stringify(state)};
const op = security ? args[0] : args.includes('--sign') ? 'sign' : args[0];
if (config.diagnostic && config.fail === op) console.error(config.diagnostic);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: security ? 'security' : 'codesign', args }) + '\\n');
if (config.pause === op) await new Promise(resolve => setTimeout(resolve, 10000));
const keychain = args.at(-1);
if (security && op === 'create-keychain') {
  writeFileSync(keychain, 'temporary keychain');
  writeFileSync(state, JSON.stringify([...JSON.parse(readFileSync(state)), keychain]));
}
if (config.fail === op || (config.fail === 'restore' && op === 'list-keychains' && args.includes('-s') && !args[4]?.includes('dbx-mcp-signing-'))) process.exit(19);
if (security) {
  if (op === 'list-keychains') {
    if (args.includes('-s')) writeFileSync(state, JSON.stringify(args.slice(4)));
    else console.log(JSON.parse(readFileSync(state)).map(keychain => JSON.stringify(keychain)).join('\\n'));
  }
  if (op === 'find-identity') console.log(config.identities ?? '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: DBX (ABCDE12345)"');
  if (op === 'delete-keychain') rmSync(keychain);
} else {
  const binary = args.at(-1);
  const marker = '\\nFAKE_SIGNATURE=';
  const text = readFileSync(binary, 'utf8');
  const payload = text.split(marker)[0];
  const hash = createHash('sha256').update(payload).digest('hex');
  if (op === 'sign') {
    const metadata = { hash, requirement: args[args.indexOf('--requirements') + 1].replace('=designated => ', ''), identifier: args[args.indexOf('--identifier') + 1], team: 'ABCDE12345' };
    writeFileSync(binary, payload + marker + JSON.stringify(metadata));
  } else {
    if (!text.includes(marker)) process.exit(20);
    const metadata = JSON.parse(text.split(marker)[1]);
    if (metadata.hash !== hash) process.exit(21);
    if (op === '--verify' && args[args.indexOf('-R') + 1] !== '=' + metadata.requirement) process.exit(22);
    if (op === '--display') {
      console.log('Identifier=' + (config.identifier ?? metadata.identifier));
      console.log('TeamIdentifier=' + (config.team ?? metadata.team));
      console.log(config.adhoc ? 'Signature=adhoc' : 'Signature size=1234');
      if (!config.noTimestamp) console.log('Timestamp=Oct 2, 2026 at 1:00:00 PM');
      console.log('designated => ' + (config.requirement ?? metadata.requirement.replaceAll(' exists', ' /* exists */')));
    }
  }
}
`;
  for (const tool of ["security", "codesign"]) writeFileSync(join(root, tool), source, { mode: 0o755 });
  const options = {
    platform: "darwin", security: join(root, "security"), codesign: join(root, "codesign"),
    env: { RUNNER_TEMP: root, APPLE_TEAM_ID: "ABCDE12345", APPLE_CERTIFICATE: Buffer.from("fixture certificate").toString("base64"),
      APPLE_CERTIFICATE_PASSWORD: "fixture password", APPLE_SIGNING_IDENTITY: "Developer ID Application: DBX (ABCDE12345)" },
  };
  return {
    root, binary, options, original,
    configure: (value) => writeFileSync(settings, JSON.stringify(value)),
    commands: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    cleaned: () => {
      assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), original);
      assert.ok(!readdirSync(root).some((name) => name.startsWith("dbx-mcp-signing-")));
    },
  };
}

test("imports only into an isolated keychain, signs and verifies in order, then restores all keychains", async () => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  scenario.cleaned();
  const commands = scenario.commands();
  assert.deepEqual(commands.map(({ tool, args }) => `${tool}:${args[0]}`), [
    "security:list-keychains", "security:create-keychain", "security:set-keychain-settings", "security:unlock-keychain",
    "security:import", "security:set-key-partition-list", "security:list-keychains", "security:find-identity",
    "codesign:--force", "codesign:--verify", "codesign:--display", "security:list-keychains", "security:delete-keychain",
  ]);
  const imported = commands.find(({ args }) => args[0] === "import").args;
  assert.ok(!imported.includes("-A"));
  assert.equal(imported[imported.indexOf("-T") + 1], "/usr/bin/codesign");
  const signing = commands.find(({ args }) => args.includes("--sign")).args;
  assert.equal(signing[signing.indexOf("--sign") + 1], "A".repeat(40));
  assert.equal(signing[signing.indexOf("--identifier") + 1], mcpIdentifier);
  assert.ok(signing.includes("--timestamp"));
  assert.ok(!signing.includes("--timestamp=none"));
  const verify = commands.find(({ args }) => args[0] === "--verify").args;
  assert.ok(verify.includes("--strict") && verify.includes("--all-architectures"));
  assert.equal(verify[verify.indexOf("-R") + 1], `=${mcpRequirement("ABCDE12345")}`);
  assert.deepEqual(commands.at(-2).args.slice(4), scenario.original);
  assert.match(commands.at(-1).args[1], /dbx-mcp-signing-.*\/signing.keychain-db$/);
});

test("distinct builds and renewed certificates keep the same signer-constrained requirement", async () => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  const first = readFileSync(scenario.binary, "utf8");
  writeFileSync(scenario.binary, "second build");
  scenario.configure({ identities: `  1) ${"B".repeat(40)} "Developer ID Application: DBX (ABCDE12345)"` });
  await signMcp(scenario.binary, scenario.options);
  assert.notEqual(readFileSync(scenario.binary, "utf8"), first);
  const signatures = scenario.commands().filter(({ args }) => args.includes("--sign")).map(({ args }) => args);
  assert.notEqual(signatures[0][2], signatures[1][2]);
  assert.equal(signatures[0][signatures[0].indexOf("--requirements") + 1], signatures[1][signatures[1].indexOf("--requirements") + 1]);
  assert.match(mcpRequirement("ABCDE12345"), /anchor apple generic/);
  assert.match(mcpRequirement("ABCDE12345"), /certificate leaf\[subject.OU\] = "ABCDE12345"/);
  assert.match(mcpRequirement("ABCDE12345"), /field.1.2.840.113635.100.6.1.13/);
  assert.doesNotMatch(mcpRequirement("ABCDE12345"), /cdhash|certificate leaf = H/);
  scenario.cleaned();
});

test("rejects unsupported hosts, missing credentials and malformed teams before keychain access", async () => {
  const scenario = fixture();
  await assert.rejects(signMcp(scenario.binary, { ...scenario.options, platform: "linux" }), /requires macOS/);
  await assert.rejects(verifyMcp(scenario.binary, { ...scenario.options, platform: "win32" }), /requires macOS/);
  for (const name of ["APPLE_TEAM_ID", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY"]) {
    await assert.rejects(signMcp(scenario.binary, { ...scenario.options, env: { ...scenario.options.env, [name]: "" } }), /required/);
  }
  await assert.rejects(signMcp(scenario.binary, { ...scenario.options, env: { ...scenario.options.env, APPLE_TEAM_ID: 'x" or true' } }), /APPLE_TEAM_ID/);
  await assert.rejects(signMcp(scenario.binary, { ...scenario.options, env: { ...scenario.options.env, APPLE_CERTIFICATE: "invalid!" } }), /base64/);
  assert.deepEqual(scenario.commands(), []);
});

test.each(["create-keychain", "set-keychain-settings", "unlock-keychain", "import", "set-key-partition-list", "find-identity", "sign", "--verify", "--display"])("propagates %s failure and cleans up", async (fail) => {
  const scenario = fixture({ fail });
  await assert.rejects(signMcp(scenario.binary, scenario.options), /failed/);
  scenario.cleaned();
  assert.equal(scenario.commands().at(-1).args[0], "delete-keychain");
});

test.each([
  { identities: '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: DBX (OTHER12345)"' },
  { identities: '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: DBX (ABCDE12345)"' },
  { identities: "0 valid identities found" },
  { team: "OTHER12345" }, { identifier: "com.dbx.app" }, { adhoc: true }, { noTimestamp: true },
  { requirement: 'identifier "com.dbx.app.mcp"' }, { requirement: 'cdhash H"abcd"' },
])("rejects invalid signer or signature metadata: %j", async (config) => {
  const scenario = fixture(config);
  await assert.rejects(signMcp(scenario.binary, scenario.options), /identity|identifier|requirement/);
  scenario.cleaned();
});

test.each(["restore", "delete-keychain"])("cleanup failure at %s fails the release and still removes temporary material", async (fail) => {
  const scenario = fixture({ fail });
  await assert.rejects(signMcp(scenario.binary, scenario.options), /cleanup failed/);
  assert.ok(!readdirSync(scenario.root).some((name) => name.startsWith("dbx-mcp-signing-")));
  assert.equal(scenario.commands().at(-1).args[0], "delete-keychain");
});

test("signature survives package staging and tar repacking, while tampering and unsigned reruns fail", async () => {
  const scenario = fixture();
  await assert.rejects(verifyMcp(scenario.binary, scenario.options), /failed/);
  await signMcp(scenario.binary, scenario.options);
  const staged = join(scenario.root, "package", "bin");
  const unpacked = join(scenario.root, "unpacked");
  mkdirSync(staged, { recursive: true });
  mkdirSync(unpacked);
  copyFileSync(scenario.binary, join(staged, "dbx-mcp"));
  assert.equal(spawnSync("tar", ["-czf", join(scenario.root, "package.tgz"), "-C", scenario.root, "package"]).status, 0);
  assert.equal(spawnSync("tar", ["-xzf", join(scenario.root, "package.tgz"), "-C", unpacked]).status, 0);
  const binary = join(unpacked, "package", "bin", "dbx-mcp");
  assert.deepEqual(readFileSync(binary), readFileSync(scenario.binary));
  await verifyMcp(binary, scenario.options);
  writeFileSync(binary, readFileSync(binary, "utf8").replace("first build", "tampered build"));
  await assert.rejects(verifyMcp(binary, scenario.options), /failed/);
  scenario.cleaned();
});

function workflowFixture(scenario, config: { existing?: boolean; corrupt?: boolean; replacement?: string } = {}) {
  const mocks = join(scenario.root, "tools");
  mkdirSync(mocks);
  const npmLog = join(scenario.root, "npm.jsonl");
  writeFileSync(join(mocks, "node"), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { signMcp, verifyMcp } from ${JSON.stringify(pathToFileURL(resolve(".github/scripts/sign-mcp-macos.mjs")).href)};
const args = process.argv.slice(2);
if (args[0] === '.github/scripts/sign-mcp-macos.mjs') {
  try { await (args[1] === 'sign' ? signMcp : verifyMcp)(args[2], ${JSON.stringify(scenario.options)}); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const child = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
}
`, { mode: 0o755 });
  writeFileSync(join(mocks, "npm"), `#!${process.execPath}
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'view') process.exit(${config.existing ? 0 : 1});
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const staging = join(destination, 'input');
  const bin = join(staging, 'package/bin');
  mkdirSync(bin, { recursive: true });
  const name = args[1].includes('win32') ? 'dbx-mcp.exe' : 'dbx-mcp';
  const source = args[1].startsWith('./') ? join(args[1], 'bin', name) : ${JSON.stringify(scenario.binary)};
  copyFileSync(source, join(bin, name));
  if (${Boolean(config.replacement)}) copyFileSync(${JSON.stringify(config.replacement ?? "")}, join(bin, name));
  if (${Boolean(config.corrupt)}) writeFileSync(join(bin, name), 'unsigned package');
  writeFileSync(join(staging, 'package/package.json'), '{}');
  const filename = 'mcp-fixture.tgz';
  const result = spawnSync('tar', ['-czf', join(destination, filename), '-C', staging, 'package']);
  if (result.status !== 0) process.exit(result.status ?? 1);
  rmSync(staging, { recursive: true });
  console.log(JSON.stringify([{ filename }]));
}
`, { mode: 0o755 });
  writeFileSync(join(mocks, "jq"), `#!${process.execPath}
import { readFileSync } from 'node:fs';
console.log(JSON.parse(readFileSync(process.argv.at(-1), 'utf8'))[0].filename);
`, { mode: 0o755 });
  writeFileSync(join(mocks, "zip"), `#!/usr/bin/env python3
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[2], 'w') as archive:
    archive.write(sys.argv[3], os.path.basename(sys.argv[3]))
`, { mode: 0o755 });
  return {
    run: (script, leg = { target: "aarch64-apple-darwin", "package-dir": "mcp-darwin-arm64", "package-name": "@dbx-app/mcp-darwin-arm64", binary: "dbx-mcp", os: "macOS" }) => {
      const expanded = script.replace(/\$\{\{ matrix\.([^ }]+) \}\}/g, (_expression, key) => leg[key]).replaceAll("${{ runner.os }}", leg.os);
      const mockPath = `${mocks}:/usr/bin:/bin`;
      const isolatedScript = `export PATH=${JSON.stringify(mockPath)}\n[[ "$(command -v npm)" == ${JSON.stringify(join(mocks, "npm"))} ]]\n[[ "$(command -v node)" == ${JSON.stringify(join(mocks, "node"))} ]]\n${expanded}`;
      return spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", isolatedScript], {
        cwd: scenario.root, encoding: "utf8", env: { PATH: mockPath, HOME: scenario.root, TMPDIR: scenario.root, RUNNER_TEMP: scenario.root, VERSION: "0.4.104" },
      });
    },
    npmCommands: () => existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

test.each(["arm64", "x64"])("macOS %s workflow stages and publishes the exact signed npm tarball", async (arch) => {
  const scenario = fixture();
  const workflowScenario = workflowFixture(scenario);
  const leg = { target: arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin", "package-dir": `mcp-darwin-${arch}`,
    "package-name": `@dbx-app/mcp-darwin-${arch}`, binary: "dbx-mcp", os: "macOS" };
  const release = join(scenario.root, "target", leg.target, "release");
  mkdirSync(release, { recursive: true });
  copyFileSync(scenario.binary, join(release, leg.binary));
  const steps = workflow.jobs["publish-mcp-platforms"].steps;
  for (const name of ["Sign macOS MCP binary", "Stage platform package", "Publish platform package"]) {
    const result = workflowScenario.run(steps.find((step) => step.name === name).run, leg);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(readFileSync(join(release, leg.binary)), readFileSync(join(scenario.root, "packages", leg["package-dir"], "bin", leg.binary)));
  const publish = workflowScenario.npmCommands().find((args) => args[0] === "publish");
  assert.match(publish[1], /mcp-fixture.tgz$/);
  assert.ok(publish.includes("--ignore-scripts"));
  assert.ok(!existsSync(publish[1]));
  scenario.cleaned();
});

test.each([true, false])("npm reruns verify existing artifacts and reject unsigned ones (corrupt=%s)", async (corrupt) => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  const workflowScenario = workflowFixture(scenario, { existing: true, corrupt });
  const script = workflow.jobs["publish-mcp-platforms"].steps.find((step) => step.name === "Publish platform package").run;
  const result = workflowScenario.run(script);
  assert.equal(result.status, corrupt ? 1 : 0, result.stderr);
  assert.ok(!workflowScenario.npmCommands().some((args) => args[0] === "publish"));
  assert.ok(workflowScenario.npmCommands().find((args) => args[0] === "pack")[1].endsWith("@0.4.104"));
  scenario.cleaned();
});

test("an altered new npm tarball blocks publication", async () => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  const workflowScenario = workflowFixture(scenario, { corrupt: true });
  mkdirSync(join(scenario.root, "packages/mcp-darwin-arm64/bin"), { recursive: true });
  copyFileSync(scenario.binary, join(scenario.root, "packages/mcp-darwin-arm64/bin/dbx-mcp"));
  const result = workflowScenario.run(workflow.jobs["publish-mcp-platforms"].steps.find((step) => step.name === "Publish platform package").run);
  assert.equal(result.status, 1);
  assert.ok(!workflowScenario.npmCommands().some((args) => args[0] === "publish"));
});

test("packaging cannot substitute a different valid signed build", async () => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  const replacement = join(scenario.root, "different-build");
  writeFileSync(replacement, "a different valid build");
  await signMcp(replacement, scenario.options);
  const workflowScenario = workflowFixture(scenario, { replacement });
  mkdirSync(join(scenario.root, "packages/mcp-darwin-arm64/bin"), { recursive: true });
  copyFileSync(scenario.binary, join(scenario.root, "packages/mcp-darwin-arm64/bin/dbx-mcp"));
  const result = workflowScenario.run(workflow.jobs["publish-mcp-platforms"].steps.find((step) => step.name === "Publish platform package").run);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /differ/);
  assert.ok(!workflowScenario.npmCommands().some((args) => args[0] === "publish"));
});

test.each(["Linux", "Windows"])("%s npm publication keeps its existing path without invoking macOS tools", (os) => {
  const scenario = fixture();
  const workflowScenario = workflowFixture(scenario);
  const result = workflowScenario.run(workflow.jobs["publish-mcp-platforms"].steps.find((step) => step.name === "Publish platform package").run,
    { target: "unused", "package-dir": "mcp-fixture", "package-name": "@dbx-app/mcp-fixture", binary: "dbx-mcp", os });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(workflowScenario.npmCommands().at(-1), ["publish", "./packages/mcp-fixture", "--access", "public", "--provenance"]);
  assert.deepEqual(scenario.commands(), []);
});

test("standalone archive workflow preserves npm signatures and produces Homebrew checksums", async () => {
  const scenario = fixture();
  await signMcp(scenario.binary, scenario.options);
  const workflowScenario = workflowFixture(scenario);
  const script = workflow.jobs["publish-mcp-github-release"].steps.find((step) => step.name === "Build native release archives from npm packages").run;
  const result = workflowScenario.run(script);
  assert.equal(result.status, 0, result.stderr);
  for (const arch of ["arm64", "x64"]) {
    const binary = spawnSync("tar", ["-xOzf", join(scenario.root, `release-assets/dbx-mcp-darwin-${arch}.tar.gz`), "dbx-mcp"]);
    assert.equal(binary.status, 0);
    assert.deepEqual(binary.stdout, readFileSync(scenario.binary));
  }
  assert.equal(readFileSync(join(scenario.root, "release-assets/SHA256SUMS"), "utf8").trim().split("\n").length, 6);
  const sums = spawnSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: join(scenario.root, "release-assets"), encoding: "utf8" });
  assert.equal(sums.status, 0, sums.stderr);
});

test("interruption waits for the signing command to stop and restores the keychain search list", async () => {
  const scenario = fixture({ pause: "import" });
  const controller = new AbortController();
  const result = assert.rejects(signMcp(scenario.binary, { ...scenario.options, signal: controller.signal }), /failed/);
  const deadline = Date.now() + 5000;
  while (!scenario.commands().some(({ args }) => args[0] === "import") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(scenario.commands().some(({ args }) => args[0] === "import"));
  controller.abort();
  await result;
  scenario.cleaned();
  assert.ok(!scenario.commands().some(({ args }) => args.includes("--sign")));
});

test("all MCP build paths are covered and CLI jobs keep their original release behavior", () => {
  for (const [name, job] of Object.entries(workflow.jobs) as [string, any][]) {
    const buildsMcp = job.steps?.some((step) => /cargo (?:build|zigbuild).* -p dbx-mcp\b/.test(step.run ?? ""));
    if (buildsMcp) assert.equal(name, "publish-mcp-platforms", "A new MCP build path needs signing coverage");
    if (name.startsWith("publish-cli")) {
      assert.ok(!JSON.stringify(job).includes("sign-mcp-macos"));
    }
  }
});

test("tool diagnostics and credential arguments are not exposed in signing errors", async () => {
  const scenario = fixture({ fail: "import", diagnostic: "sensitive mocked certificate error" });
  await assert.rejects(signMcp(scenario.binary, scenario.options), (error: Error) => {
    assert.equal(error.message, "security import failed.");
    assert.ok(!error.message.includes(scenario.options.env.APPLE_CERTIFICATE_PASSWORD));
    return true;
  });
  scenario.cleaned();
});

test("standalone repacking rejects unsigned npm artifacts before producing checksums", () => {
  const scenario = fixture();
  const workflowScenario = workflowFixture(scenario);
  const result = workflowScenario.run(workflow.jobs["publish-mcp-github-release"].steps.find((step) => step.name === "Build native release archives from npm packages").run);
  assert.equal(result.status, 1);
  assert.ok(!existsSync(join(scenario.root, "release-assets/SHA256SUMS")));
});
