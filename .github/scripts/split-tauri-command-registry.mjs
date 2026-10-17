import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const startMarker = ".invoke_handler(migration_gate::guard_handler(route_external_commands(tauri::generate_handler![";
const endMarker = "        ])))";
const insertMarker = "fn route_external_commands(";

export function splitCommandRegistry(source) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + 1) >= 0) {
    throw new Error("Expected one main Tauri command registry.");
  }

  const body = source.slice(start + startMarker.length, end);
  const lines = body.split("\n");
  const entries = [];
  let attributes = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#\[cfg\([^\n]+\)\]$/.test(trimmed)) {
      attributes.push(trimmed);
      continue;
    }
    const match = /^([a-z_][a-z_0-9]*(?:::[a-z_][a-z_0-9]*)+),$/.exec(trimmed);
    if (!match) throw new Error(`Unexpected registry line: ${trimmed}`);
    entries.push({ path: match[1], attributes });
    attributes = [];
  }
  if (attributes.length || entries.length < 2) throw new Error("Invalid command registry.");
  const names = entries.map(({ path }) => path.split("::").at(-1));
  if (new Set(names).size !== names.length) throw new Error("Duplicate command names.");

  const half = Math.ceil(entries.length / 2);
  const renderEntries = (items, indent) => items.map(({ path, attributes }) => [
    ...attributes.map((attribute) => `${indent}${attribute}`),
    `${indent}${path},`,
  ].join("\n")).join("\n");
  const renderNames = (items) => items.map(({ path, attributes }) => [
    ...attributes.map((attribute) => `        ${attribute}`),
    `        "${path.split("::").at(-1)}",`,
  ].join("\n")).join("\n");
  const first = entries.slice(0, half);
  const second = entries.slice(half);
  const replacement = `${startMarker.replace("route_external_commands(tauri", "route_external_commands(command_registry_split::route(tauri")}\n${renderEntries(first, "            ")}\n        ]))))`;
  const module = `mod command_registry_split {
    use super::*;

    const COMMANDS: &[&str] = &[
${renderNames(second)}
    ];

    fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
        tauri::generate_handler![
${renderEntries(second, "            ")}
        ]
    }

    pub fn route(
        main_handler: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
    ) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
        let split_handler = invoke_handler();
        move |invoke| {
            if COMMANDS.contains(&invoke.message.command()) {
                split_handler(invoke)
            } else {
                main_handler(invoke)
            }
        }
    }
}

`;
  const withoutRegistry = source.slice(0, start) + replacement + source.slice(end + endMarker.length);
  const insert = withoutRegistry.indexOf(insertMarker);
  if (insert < 0 || withoutRegistry.indexOf(insertMarker, insert + 1) >= 0) {
    throw new Error("Expected one external command router.");
  }
  return { source: withoutRegistry.slice(0, insert) + module + withoutRegistry.slice(insert), counts: { full: entries.length, first: first.length, second: second.length } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node split-tauri-command-registry.mjs <src-tauri/src/lib.rs>");
  const result = splitCommandRegistry(readFileSync(path, "utf8"));
  writeFileSync(path, result.source);
  process.stdout.write(`${JSON.stringify(result.counts)}\n`);
}
