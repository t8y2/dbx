// Test-environment shim for happy-dom >= 20.10: `localStorage` and `sessionStorage` are
// exposed as prototype getters on Window, and vitest's `populateGlobal` only copies own
// properties, so the globals never reach the test context. Persistence specs then crash
// with "Cannot read properties of undefined (reading 'getItem')". Alias a real happy-dom
// storage implementation (fresh per test file, in-memory) to keep the semantics intact.
if (typeof globalThis.localStorage === "undefined" && typeof globalThis.document !== "undefined") {
  const { Window } = await import("happy-dom");
  const storageWindow = new Window({ url: "http://localhost:3000" });
  Object.defineProperty(globalThis, "localStorage", {
    get: () => storageWindow.localStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    get: () => storageWindow.sessionStorage,
    configurable: true,
  });
}
