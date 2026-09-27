import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

type ScopedPermission = { identifier: string; allow?: { path: string }[]; deny?: { path: string }[] };
const capability = JSON.parse(readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8")) as {
  permissions: (string | ScopedPermission)[];
};

it("grants only exists and readTextFile command scopes for the exact UI tuning file", () => {
  const scopes = capability.permissions.filter((permission): permission is ScopedPermission => typeof permission !== "string" && permission.identifier.startsWith("fs:"));
  expect(scopes).toEqual([
    { identifier: "fs:allow-exists", allow: [{ path: "$HOME/.dbx/ui-tuning.json" }] },
    { identifier: "fs:allow-read-text-file", allow: [{ path: "$HOME/.dbx/ui-tuning.json" }] },
  ]);
  expect(capability.permissions).not.toContain("fs:scope");
  expect(capability.permissions.filter((permission) => typeof permission === "string" && permission.startsWith("fs:"))).toEqual(["fs:default", "fs:allow-write-file", "fs:allow-write-text-file", "fs:allow-stat", "fs:allow-read-file", "fs:allow-open", "fs:allow-read"]);
});
