import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { isMainModule } from "../src/entrypoint.js";

test("matches a module invoked through its real file path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-entrypoint-"));
  try {
    const entry = join(dir, "cli.js");
    await writeFile(entry, "", "utf-8");

    assert.equal(isMainModule(pathToFileURL(entry).href, entry), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("matches a module invoked through an npm-style symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-entrypoint-"));
  try {
    const entry = join(dir, "dist", "cli.js");
    const bin = join(dir, "dbx");
    await mkdir(join(dir, "dist"));
    await writeFile(entry, "", "utf-8");
    try {
      await symlink(entry, bin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      return;
    }

    assert.equal(isMainModule(pathToFileURL(entry).href, bin), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not match a different entry file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-entrypoint-"));
  try {
    const entry = join(dir, "cli.js");
    const other = join(dir, "other.js");
    await writeFile(entry, "", "utf-8");
    await writeFile(other, "", "utf-8");

    assert.equal(isMainModule(pathToFileURL(entry).href, other), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
