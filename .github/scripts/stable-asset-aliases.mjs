#!/usr/bin/env node

// A promoted beta keeps its beta-versioned packages, because latest.json and the
// updater point at them, and also publishes the stable file names that the
// website, Homebrew and Scoop build from the plain version.
//
//   stable-asset-aliases.mjs pairs <tag>          print "<source> <target>" lines
//   stable-asset-aliases.mjs apply <tag> <dir>    copy sources to targets inside <dir>

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const betaTag = /^v(\d+\.\d+\.\d+)(-beta\.\d{8}\.\d+)$/;
const packageSuffixes = [
  "arm64.dmg",
  "x64.dmg",
  "x64-setup.exe",
  "arm64-setup.exe",
  "x64_en-US.msi",
  "arm64_en-US.msi",
  "amd64.AppImage",
  "arm64.AppImage",
  "amd64.deb",
  "arm64.deb",
  "arm64.rpm",
];

export function stableAliasPairs(tag) {
  const match = betaTag.exec(tag);
  if (!match) return [];
  const [, baseVersion, betaSuffix] = match;
  const betaVersion = `${baseVersion}${betaSuffix}`;
  return [
    ...packageSuffixes.map((suffix) => [`DBX_${betaVersion}_${suffix}`, `DBX_${baseVersion}_${suffix}`]),
    // The x86_64 rpm is named by rpmbuild rather than by the Tauri bundler.
    [`DBX-${betaVersion}-1.x86_64.rpm`, `DBX-${baseVersion}-1.x86_64.rpm`],
  ];
}

export function applyStableAliases(tag, directory) {
  const created = [];
  for (const [source, target] of stableAliasPairs(tag)) {
    if (existsSync(join(directory, target))) continue;
    if (!existsSync(join(directory, source))) throw new Error(`Missing beta package asset ${source}.`);
    copyFileSync(join(directory, source), join(directory, target));
    created.push(target);
  }
  return created;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, tag, directory] = process.argv.slice(2);
  try {
    if (command === "pairs" && tag) {
      for (const [source, target] of stableAliasPairs(tag)) console.log(`${source} ${target}`);
    } else if (command === "apply" && tag && directory) {
      const created = applyStableAliases(tag, directory);
      console.log(created.length ? `Created stable aliases: ${created.join(", ")}` : "No stable aliases to create.");
    } else {
      console.error("Usage: stable-asset-aliases.mjs pairs <tag> | apply <tag> <directory>");
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
