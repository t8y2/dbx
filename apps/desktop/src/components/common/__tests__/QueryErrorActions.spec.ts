// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryErrorActions from "@/components/common/QueryErrorActions.vue";
import i18n from "@/i18n";

const mountedApps: App[] = [];

async function mountActions(errorMessage: string, options: { onChangeConnectionTimeout?: () => void; errorPosition?: { line: number; column: number }; onLocateError?: () => void } = {}) {
  const onChangeConnectionTimeout = options.onChangeConnectionTimeout ?? vi.fn();
  const onLocateError = options.onLocateError ?? vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    setup: () => () =>
      h(QueryErrorActions, {
        errorMessage,
        connectionId: "postgres-1",
        errorPosition: options.errorPosition,
        onChangeConnectionTimeout,
        onLocateError,
      }),
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(host);
  await nextTick();
  return { host, onChangeConnectionTimeout, onLocateError };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("QueryErrorActions", () => {
  it("offers connection timeout settings for PostgreSQL connection creation timeouts", async () => {
    const { host, onChangeConnectionTimeout } = await mountActions("PostgreSQL connection failed: Timeout occurred while creating a new object SQL text omitted from user-facing error");
    const timeoutButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Change connection timeout"));

    expect(timeoutButton).toBeTruthy();
    timeoutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onChangeConnectionTimeout).toHaveBeenCalledOnce();
  });

  it("offers a locate-error action when the backend reports a position", async () => {
    const { host, onLocateError } = await mountActions("ERROR: relation does not exist", {
      errorPosition: { line: 2, column: 6 },
    });
    const locateButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Locate error"));

    expect(locateButton?.textContent).toContain("line 2, col 6");
    locateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLocateError).toHaveBeenCalledOnce();
  });

  it("hides the locate-error action without a position", async () => {
    const { host } = await mountActions("ERROR: relation does not exist");

    expect(host.textContent).not.toContain("Locate error");
  });

  it("does not offer connection timeout settings for query timeouts", async () => {
    const { host } = await mountActions("Query timed out after 30 seconds");

    expect(host.textContent).not.toContain("Change connection timeout");
    expect(host.textContent).toContain("Change query timeout");
  });

  it("shows only connection timeout settings for connect-stage agent RPC timeouts", async () => {
    const { host } = await mountActions("Agent RPC call timed out at connect");
    const labels = Array.from(host.querySelectorAll("button"), (button) => button.textContent?.trim());

    expect(labels).toContain("Change connection timeout");
    expect(labels).not.toContain("Change query timeout");
  });

  it("does not offer query timeout settings for non-query Agent RPC stages", async () => {
    for (const stage of ["request", "validate", "cancel", "close"]) {
      const { host } = await mountActions(`Agent RPC call timed out at ${stage}`);

      expect(host.textContent).not.toContain("Change query timeout");
    }
  });
});
