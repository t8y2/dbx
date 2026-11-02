import { readFileSync, writeFileSync } from "node:fs";

const [version, sumsPath, outputPath] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !sumsPath || !outputPath) {
  throw new Error("Usage: render-mcp-formula.mjs <version> <SHA256SUMS> <output.rb>");
}
const sums = readFileSync(sumsPath, "utf8").trim().split(/\r?\n/);
let formula = readFileSync(new URL("./dbx-mcp.rb.template", import.meta.url), "utf8").replaceAll("__VERSION__", version);
for (const [platform, placeholder] of [
  ["darwin-arm64", "__SHA_DARWIN_ARM64__"],
  ["darwin-x64", "__SHA_DARWIN_X64__"],
  ["linux-arm64-gnu", "__SHA_LINUX_ARM64__"],
  ["linux-x64-gnu", "__SHA_LINUX_X64__"],
]) {
  const matches = sums.map((line) => line.trim().split(/\s+/)).filter(([, name]) => name === `dbx-mcp-${platform}.tar.gz`);
  if (matches.length !== 1 || !/^[a-fA-F0-9]{64}$/.test(matches[0][0])) {
    throw new Error(`Missing, duplicate, or invalid SHA256 for ${platform}`);
  }
  formula = formula.replaceAll(placeholder, matches[0][0].toLowerCase());
}
writeFileSync(outputPath, formula);
