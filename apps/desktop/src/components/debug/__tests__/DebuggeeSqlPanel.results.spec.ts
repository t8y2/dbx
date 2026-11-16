// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/stores/plDebugStore", () => ({ usePlDebugStore: () => ({ hasSession: true, terminated: false, busy: false, executeInDebuggee: execute }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: { error?: string }) => (params?.error ? `${key}: ${params.error}` : key) }) }));
import DebuggeeSqlPanel from "../DebuggeeSqlPanel.vue";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

it("keeps execution failure and result completeness reasons beside partial rows without misreporting a successful execution", async () => {
  execute.mockResolvedValueOnce({ ok: true, rows: ["partial"], count: 1, complete: false, resultError: "Original result capture incomplete" });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(DebuggeeSqlPanel);
  app.mount(root);
  const input = root.querySelector("input")!;
  input.value = "BEGIN :1 := rows; END;";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  root.querySelector("button")!.click();
  await vi.waitFor(() => expect(root.textContent).toContain("Original result capture incomplete"));
  expect(root.textContent).toContain("partial");
  expect(root.textContent).toContain("plDebug.sql.incomplete");
  expect(root.textContent).not.toContain("plDebug.sql.failed");
  execute.mockResolvedValueOnce({ ok: false, rows: [null, "failure partial"], count: 2, complete: false, error: "ORA-20001: original SQL failure", resultError: "Remaining rows unavailable" });
  root.querySelector("button")!.click();
  await vi.waitFor(() => expect(root.textContent).toContain("ORA-20001: original SQL failure"));
  expect(root.textContent).toContain("Remaining rows unavailable");
  expect(root.textContent).toContain("NULL");
  expect(root.textContent).toContain("failure partial");
  expect(input.value).toBe("BEGIN :1 := rows; END;");
  execute.mockResolvedValueOnce({ ok: true, rows: ["bounded"], count: 1, complete: false, truncated: true });
  root.querySelector("button")!.click();
  await vi.waitFor(() => expect(root.textContent).toContain("plDebug.sql.limited"));
  expect(root.textContent).toContain("bounded");
  expect(root.textContent).not.toContain("ORA-20001");
  expect(root.textContent).not.toContain("plDebug.sql.incomplete");
});

it("distinguishes NULL from empty text and retains result rows and input after a later failed read", async () => {
  execute.mockResolvedValueOnce({ ok: true, rows: [null, "", "中\ntext"] });
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(DebuggeeSqlPanel);
  app.mount(root);
  const input = root.querySelector("input")!;
  input.value = "BEGIN :1 := results; END;";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  root.querySelector("button")!.click();
  await vi.waitFor(() => expect(root.querySelectorAll("tbody tr")).toHaveLength(3));
  const values = [...root.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1].textContent);
  expect(values).toEqual(["NULL", "", "中\ntext"]);
  execute.mockRejectedValueOnce(new Error("Original SQL receipt is unknown; do not repeat"));
  root.querySelector("button")!.click();
  await vi.waitFor(() => expect(root.textContent).toContain("Original SQL receipt is unknown"));
  expect(root.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(input.value).toBe("BEGIN :1 := results; END;");
  expect(execute).toHaveBeenCalledTimes(2);
});
