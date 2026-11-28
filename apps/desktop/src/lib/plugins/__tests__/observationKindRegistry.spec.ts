import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REGISTERED_OBSERVATION_KINDS } from "../pluginObservation";

/**
 * The Rust registry (`OBSERVATION_KINDS` in dbx-types) is the source of truth
 * for what the host delivers; the TypeScript mirror decides what a plugin UI
 * accepts. If they drift, a delivered event is silently dropped in the UI (or
 * a kind is accepted that the host never sends), so pin them to each other.
 */
describe("observation kind registry", () => {
  it("matches the Rust OBSERVATION_KINDS registry", () => {
    const rust = readFileSync(path.resolve(process.cwd(), "crates/dbx-types/src/models/observability.rs"), "utf8");
    const constants = new Map([...rust.matchAll(/pub const (KIND_\w+): &str = "([^"]+)";/g)].map((match) => [match[1], match[2]]));
    const registered = [...rust.matchAll(/^\s*(?:ui_only|kind)\((\w+), ObservationCategory::\w+\)/gm)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(20);

    const rustKinds = registered.map((name) => constants.get(name));
    expect(rustKinds.every((kind) => typeof kind === "string")).toBe(true);
    expect([...rustKinds].sort()).toEqual(Object.keys(REGISTERED_OBSERVATION_KINDS).sort());
  });
});
