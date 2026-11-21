import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/**
 * Desktop keeps a short poll so MCP / CLI / another window rewriting
 * `sidebar_layout` becomes visible without restart.
 *
 * Web / Docker shares one `sidebar_layout` row across browsers. Polling would
 * push each user's connection-group collapse state onto everyone else, so the
 * web build relies on the sidebar refresh action instead.
 */
export function shouldStartSidebarLayoutAutoSync(runtimeIsDesktop: boolean = isTauriRuntime(), mode: string = import.meta.env.MODE): boolean {
  if (mode === "test") return false;
  return runtimeIsDesktop;
}
