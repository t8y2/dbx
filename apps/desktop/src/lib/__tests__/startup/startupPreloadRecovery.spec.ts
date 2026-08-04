import { describe, expect, it, vi } from "vitest";
import { clearStartupPreloadRetry, retryStartupAfterPreloadFailure } from "@/lib/startup/startupPreloadRecovery";

function environment() {
  const values = new Map<string, string>();
  return {
    values,
    env: {
      sessionStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
      },
      location: { reload: vi.fn() },
    },
  };
}

describe("startup preload recovery", () => {
  it("reloads once after a CSS preload failure", () => {
    const { env } = environment();
    const error = new Error("Unable to preload CSS for http://tauri.localhost/assets/QueryLoadingState.css");

    expect(retryStartupAfterPreloadFailure(error, env)).toBe(true);
    expect(env.location.reload).toHaveBeenCalledOnce();
    expect(retryStartupAfterPreloadFailure(error, env)).toBe(false);
    expect(env.location.reload).toHaveBeenCalledOnce();
  });

  it("does not reload for unrelated startup failures", () => {
    const { env } = environment();

    expect(retryStartupAfterPreloadFailure(new Error("Database initialization failed"), env)).toBe(false);
    expect(env.location.reload).not.toHaveBeenCalled();
  });

  it("clears the retry marker after startup succeeds", () => {
    const { env, values } = environment();
    values.set("dbx-startup-preload-retry", "1");

    clearStartupPreloadRetry(env);
    expect(values.has("dbx-startup-preload-retry")).toBe(false);
  });
});
