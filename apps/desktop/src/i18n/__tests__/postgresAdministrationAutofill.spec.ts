import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import zhCN from "../locales/zh-CN";

it("the trusted autofill CLI accepts the shipped PostgreSQL locale declarations without executing imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "dbx-postgres-autofill-"));
  const localePath = "apps/desktop/src/i18n/locales";
  const locales = ["zh-CN", "en", "es", "it", "ja", "ko", "pt-BR", "ru", "th", "zh-TW"];
  const script = fileURLToPath(new URL("../../../../../.github/scripts/i18n-autofill.mjs", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    mkdirSync(join(directory, localePath), { recursive: true });
    const { postgresAdmin, ...beforeFeature } = zhCN;
    // This serialized locale is the intentional input contract of the real CLI.
    // Its baseline contains all earlier keys, so only this feature is new.
    writeFileSync(join(directory, localePath, "zh-CN.ts"), `export default ${JSON.stringify(beforeFeature)};\n`);
    git("init", "--initial-branch=main");
    git("add", ".");
    git("-c", "user.name=DBX Test", "-c", "user.email=dbx-test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "Locale baseline");
    for (const locale of locales) copyFileSync(new URL(`../locales/${locale}.ts`, import.meta.url), join(directory, localePath, `${locale}.ts`));
    const result = spawnSync(process.execPath, [script, "--dry-run", "--mock-translations", "--base-ref", "HEAD"], { cwd: directory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout || result.error?.message).toBe(0);
    expect(result.stdout).toContain(`Found ${Object.keys(postgresAdmin).length} new zh-CN i18n key(s)`);
    expect(result.stdout).toContain("en: all new keys already present");
    expect(result.stdout).toContain("pt-BR: all new keys already present");
    expect(result.stdout).toContain("zh-TW: all new keys already present");
    // The workflow may already have filled other locales on this branch.
    expect(result.stdout).toMatch(/Dry run completed; \d+ locale file\(s\) would be patched|No locale files needed changes/);
    // Exercise both states: a fresh PR and the same declarations after autofill.
    // Writes are confined to the disposable fixture and never use a service.
    const fill = spawnSync(process.execPath, [script, "--write", "--mock-translations", "--base-ref", "HEAD"], { cwd: directory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    expect(fill.status, fill.stderr).toBe(0);
    const recheck = spawnSync(process.execPath, [script, "--dry-run", "--mock-translations", "--base-ref", "HEAD"], { cwd: directory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    expect(recheck.status, recheck.stderr).toBe(0);
    expect(recheck.stdout).toContain("No locale files needed changes");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
