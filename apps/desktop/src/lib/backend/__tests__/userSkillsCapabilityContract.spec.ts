import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tauri = readFileSync(new URL("../tauri.ts", import.meta.url), "utf8");
const http = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const tauriRegistry = readFileSync(new URL("../../../../../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const webRegistry = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");
const commandModuleSource = readFileSync(new URL("../../../../../../src-tauri/src/commands/user_skills.rs", import.meta.url), "utf8");

function functionBody(source: string, operation: string): string {
  const start = source.indexOf(`export async function ${operation}(`);
  expect(start, `${operation} transport function`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("user skills transport contract", () => {
  it("routes list/read through the desktop Tauri backend", () => {
    expect(functionBody(tauri, "listUserSkills")).toContain('invoke("list_user_skills"');
    expect(functionBody(tauri, "readUserSkills")).toContain('invoke("read_user_skills"');
    expect(tauriRegistry).toContain("commands::user_skills::list_user_skills,");
    expect(tauriRegistry).toContain("commands::user_skills::read_user_skills,");
    expect(api).toContain('listUserSkills = forward("listUserSkills")');
    expect(api).toContain('readUserSkills = forward("readUserSkills")');
  });

  it("keeps the skill service strictly read-only outside its tests", () => {
    const production = commandModuleSource.slice(0, commandModuleSource.indexOf("#[cfg(test)]"));
    expect(production).not.toContain("fs::write");
    expect(production).not.toContain("fs::remove");
    expect(production).not.toContain("fs::create_dir");
    expect(production).not.toContain("OpenOptions");
  });

  it("keeps the Web transport explicitly unsupported without adding HTTP routes", () => {
    for (const operation of ["listUserSkills", "readUserSkills"]) {
      const body = functionBody(http, operation);
      expect(body).toContain("only available in the desktop app");
      expect(body).not.toContain("post(");
      expect(body).not.toContain("fetch(");
    }
    expect(webRegistry).not.toContain("user_skills");
    expect(webRegistry).not.toContain("list_user_skills");
    expect(webRegistry).not.toContain("read_user_skills");
  });
});
