#!/usr/bin/env node

// WiX/MSI only accepts numeric `major.minor.patch.build` versions, and the Tauri
// bundler rejects a pre-release such as `-beta.20261029.1`. Beta builds keep the
// full semver for the app and updater; only the MSI gets this numeric version.
// Windows Installer ignores the fourth field when comparing versions, so it is
// informational: day-of-year * 100 + the daily build sequence (max 36699).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const betaTag = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d{4})(\d{2})(\d{2})\.(\d+)$/;
const stableTag = /^v\d+\.\d+\.\d+$/;

export function msiConfigForTag(tag) {
  if (stableTag.test(tag)) return {};
  const match = betaTag.exec(tag);
  if (!match) throw new Error(`Unsupported release tag for MSI version: ${tag}`);

  const [major, minor, patch, year, month, day, sequence] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid beta build date in ${tag}.`);
  }
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error(`MSI version limits (255.255.65535) exceeded by ${tag}.`);
  }
  if (sequence < 1 || sequence > 99) {
    throw new Error(`Beta build sequence must be 1-99 to fit the MSI build field: ${tag}.`);
  }

  const dayOfYear = Math.round((date - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const build = dayOfYear * 100 + sequence;
  return { bundle: { windows: { wix: { version: `${major}.${minor}.${patch}.${build}` } } } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, output] = process.argv.slice(2);
  if (!tag || !output) {
    console.error("Usage: prepare-msi-config.mjs <release_tag> <output.json>");
    process.exit(1);
  }
  try {
    const config = msiConfigForTag(tag);
    writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Wrote ${output}: ${JSON.stringify(config)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
