import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const developmentIdentifier = "com.dbx.app.development";

export function signingDirectory() {
  return path.join(homedir(), "Library", "Application Support", "DBX", "development-signing");
}

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    throw new Error(`Development signing: ${path.basename(executable)} ${args[0]} failed (${error.status ?? error.code}).`);
  }
}

function privatePath(file, directory = false) {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile()) || metadata.uid !== process.getuid()) {
    throw new Error(`Development signing refuses an unsafe path: ${file}`);
  }
  chmodSync(file, directory ? 0o700 : 0o600);
}

function keychainSearchList() {
  const output = command("/usr/bin/security", ["list-keychains", "-d", "user"]);
  return [...output.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function canonicalKeychain(keychain) {
  return existsSync(keychain) ? realpathSync.native(keychain) : keychain;
}

function includeKeychain(keychain) {
  const canonical = canonicalKeychain(keychain);
  const keychains = keychainSearchList();
  const updated = [...keychains.filter((entry) => canonicalKeychain(entry) !== canonical), canonical];
  if (JSON.stringify(updated) !== JSON.stringify(keychains)) {
    command("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...updated]);
  }
}

export function removeSigningKeychain(keychain) {
  const canonical = canonicalKeychain(keychain);
  const keychains = keychainSearchList();
  const updated = keychains.filter((entry) => canonicalKeychain(entry) !== canonical);
  if (updated.length !== keychains.length) {
    command("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...updated]);
  }
  command("/usr/bin/security", ["delete-keychain", canonical]);
}

export function designatedRequirement(fingerprint) {
  if (!/^[A-F0-9]{40}$/.test(fingerprint)) {
    throw new Error("Invalid development certificate fingerprint.");
  }
  return `identifier "${developmentIdentifier}" and certificate leaf = H"${fingerprint}"`;
}

export function loadSigningIdentity(directory = signingDirectory()) {
  privatePath(directory, true);
  directory = realpathSync.native(directory);
  const configPath = path.join(directory, "identity.json");
  const certificatePath = path.join(directory, "certificate.pem");
  const keychain = path.join(directory, "development.keychain-db");
  for (const file of [configPath, certificatePath, keychain]) privatePath(file);
  let identity;
  try {
    identity = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Invalid development signing configuration; the existing identity was preserved.");
  }
  if (identity?.version !== 1 || !/^[a-f0-9]{64}$/.test(identity.password)) {
    throw new Error("Invalid development signing configuration; do not delete or regenerate an existing identity automatically.");
  }
  designatedRequirement(identity.fingerprint);
  const certificate = new X509Certificate(readFileSync(certificatePath));
  if (certificate.fingerprint.replaceAll(":", "") !== identity.fingerprint || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("The development certificate is mismatched or expired; replace it explicitly and authorize the new identity once.");
  }
  return { ...identity, keychain };
}

export function ensureSigningIdentity(directory = signingDirectory()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  directory = realpathSync.native(directory);
  const configPath = path.join(directory, "identity.json");
  if (existsSync(configPath)) return loadSigningIdentity(directory);
  const lockPath = path.join(directory, "setup.lock");
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error(`Development signing setup is already running or was interrupted. Check ${lockPath} before retrying.`);
  }
  const keychain = path.join(directory, "development.keychain-db");
  let temporary;
  let createdKeychain = false;
  try {
    if (existsSync(configPath)) return loadSigningIdentity(directory);
    if (existsSync(keychain) || existsSync(path.join(directory, "certificate.pem"))) {
      throw new Error(`Incomplete development signing setup in ${directory}; refusing to replace an existing identity.`);
    }
    temporary = mkdtempSync(path.join(directory, "setup-"));
    const password = randomBytes(32).toString("hex");
    const config = path.join(temporary, "openssl.cnf");
    const privateKey = path.join(temporary, "private.pem");
    const certificatePath = path.join(temporary, "certificate.pem");
    const bundle = path.join(temporary, "identity.p12");
    writeFileSync(config, ["[req]", "prompt=no", "distinguished_name=subject", "x509_extensions=extensions", "[subject]", "CN=DBX Local Development", "[extensions]", "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,codeSigning", ""].join("\n"), {
      mode: 0o600,
      flag: "wx",
    });
    command("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-config", config, "-keyout", privateKey, "-out", certificatePath]);
    command("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", privateKey, "-in", certificatePath, "-out", bundle, "-passout", "env:DBX_DEV_SIGNING_PASSWORD"], {
      env: { ...process.env, DBX_DEV_SIGNING_PASSWORD: password },
    });
    command("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    createdKeychain = true;
    command("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    command("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    command("/usr/bin/security", ["import", bundle, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    command("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain]);
    includeKeychain(keychain);
    const certificate = readFileSync(certificatePath);
    const fingerprint = new X509Certificate(certificate).fingerprint.replaceAll(":", "");
    writeFileSync(path.join(directory, "certificate.pem"), certificate, { mode: 0o600, flag: "wx" });
    writeFileSync(configPath, JSON.stringify({ version: 1, fingerprint, password }) + "\n", { mode: 0o600, flag: "wx" });
    console.error("Created a local DBX development signing identity; release certificates and connection keys were not changed.");
    return loadSigningIdentity(directory);
  } catch (error) {
    if (createdKeychain && !existsSync(configPath)) {
      removeSigningKeychain(keychain);
      rmSync(path.join(directory, "certificate.pem"), { force: true });
    }
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    closeSync(lock);
    rmSync(lockPath);
  }
}

export function signDevelopmentBinary(binary, directory = signingDirectory()) {
  const identity = loadSigningIdentity(directory);
  const requirement = designatedRequirement(identity.fingerprint);
  command("/usr/bin/security", ["unlock-keychain", "-p", identity.password, identity.keychain]);
  includeKeychain(identity.keychain);
  command("/usr/bin/codesign", ["--force", "--sign", identity.fingerprint, "--keychain", identity.keychain, "--identifier", developmentIdentifier, "--requirements", `=designated => ${requirement}`, "--preserve-metadata=entitlements", "--timestamp=none", binary]);
  command("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, binary]);
}
