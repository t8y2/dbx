export type StartupPhase = "bootstrap" | "gate-mounted" | "locale-ready" | "auth-ready" | "migration-ready" | "app-mounted" | "settings-ready" | "connections-ready" | "tabs-restored";

export function markStartupPhase(phase: StartupPhase): void {
  const name = `dbx:startup:${phase}`;
  const clock = globalThis.performance;
  if (typeof clock?.mark !== "function" || typeof clock.getEntriesByName !== "function") return;
  if (!clock.getEntriesByName(name, "mark").length) clock.mark(name);
}
