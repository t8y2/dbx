import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { splitCommandRegistry } from "./split-tauri-command-registry.mjs";

test("split registry keeps every command and feature gate", () => {
  const original = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const { source, counts } = splitCommandRegistry(original);
  assert.equal(counts.first + counts.second, counts.full);
  assert.ok(counts.full >= 740);
  assert.equal((source.match(/tauri::generate_handler!\[/g) ?? []).length, 2);
  assert.equal((source.match(/commands::mq_cmd::mq_test_connection,/g) ?? []).length, 1);
  assert.match(source, /#\[cfg\(feature = "mq-admin"\)\]\n\s+commands::mq_cmd::mq_test_connection,/);
  assert.match(source, /route_external_commands\(command_registry_split::route\(/);
  assert.match(source, /fn invoke_handler\(\) -> impl Fn\(tauri::ipc::Invoke<tauri::Wry>\) -> bool/);
  assert.match(source, /COMMANDS\.contains\(&invoke\.message\.command\(\)\)/);
  assert.throws(() => splitCommandRegistry(source), /Expected one main Tauri command registry/);
});
