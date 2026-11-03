#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [input, output, channel = "stable", tag = "", promoted = "false", publishedAt = ""] = process.argv.slice(2);
const tagMatch = /^v(\d+\.\d+\.\d+)(-beta\.\d{8}\.\d+)?$/.exec(tag);
if (
  !input ||
  !output ||
  !["stable", "beta"].includes(channel) ||
  !tagMatch ||
  !["true", "false"].includes(promoted)
) {
  console.error("Usage: prepare-channel-manifest.mjs <input> <output> <stable|beta> <vX.Y.Z[ -beta.YYYYMMDD.N]> [true|false] [published_at]");
  process.exit(1);
}

if (channel === "beta" && !tagMatch[2]) {
  throw new Error(`Beta manifests require a beta tag: ${tag}`);
}

const manifest = JSON.parse(readFileSync(input, "utf8"));
if (!manifest || typeof manifest !== "object" || !manifest.version || !manifest.platforms || typeof manifest.platforms !== "object") {
  throw new Error("Updater manifest must contain version and platforms.");
}

const baseVersion = tagMatch[1];
const tagVersion = tag.slice(1);
if (manifest.version !== baseVersion && manifest.version !== tagVersion) {
  throw new Error(`Manifest version ${manifest.version} does not match tag version ${tagVersion} or base version ${baseVersion}.`);
}
manifest.version = channel === "beta" ? tagVersion : baseVersion;
manifest.channel = channel;
manifest.release_tag = tag;
manifest.is_promoted = promoted === "true";
manifest.published_at ||= publishedAt || new Date().toISOString();
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
