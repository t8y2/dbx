// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SqlParameterDialog from "@/components/editor/SqlParameterDialog.vue";
import type { SqlParameterDescriptor, SqlParameterInput } from "@/lib/sql/sqlParameters";

const historyMocks = vi.hoisted(() => ({
  load: vi.fn<(key: string) => SqlParameterInput[]>(),
  remember: vi.fn<(values: Record<string, SqlParameterInput>) => Record<string, SqlParameterInput[]>>(),
}));

vi.mock("@/lib/sql/sqlParameterHistory", () => ({
  loadSqlParameterHistory: historyMocks.load,
  rememberSqlParameterValues: historyMocks.remember,
}));

vi.mock("@/composables/useSqlHighlighter", () => ({
  useSqlHighlighter: () => ({ highlight: (sql: string) => `<span>${sql}</span>` }),
}));

const SQL = "SELECT ${text_value}, ${numeric_value}, ${null_value}, ${raw_value}, ${empty_value}, ${text_value}";
const PARAMETERS: SqlParameterDescriptor[] = [
  { key: "text_value", name: "text_value", syntax: "shell", token: "${text_value}" },
  { key: "numeric_value", name: "numeric_value", syntax: "shell", token: "${numeric_value}" },
  { key: "null_value", name: "null_value", syntax: "shell", token: "${null_value}" },
  { key: "raw_value", name: "raw_value", syntax: "shell", token: "${raw_value}" },
  { key: "empty_value", name: "empty_value", syntax: "shell", token: "${empty_value}" },
];
const MIXED_VALUES: Record<string, SqlParameterInput> = {
  text_value: { kind: "string", value: "alpha beta" },
  numeric_value: { kind: "number", value: " 42 " },
  null_value: { kind: "null", value: "NULL" },
  raw_value: { kind: "raw", value: "current_date" },
  empty_value: { kind: "boolean", value: "" },
};
const RAW_VALUES = Object.fromEntries(Object.entries(MIXED_VALUES).map(([key, input]) => [key, { ...input, kind: "raw" as const }]));
const RAW_SQL = "SELECT alpha beta, 42, NULL, current_date, ${empty_value}, alpha beta";
const CLEARED_VALUES: Record<string, SqlParameterInput> = {
  text_value: { kind: "string", value: "" },
  numeric_value: { kind: "number", value: "" },
  null_value: { kind: "null", value: "" },
  raw_value: { kind: "raw", value: "" },
  empty_value: { kind: "boolean", value: "" },
};
const CLEARED_SQL = "SELECT '', NULL, NULL, ${raw_value}, '', ''";

const mountedApps: App[] = [];

async function mountDialog(values: Record<string, SqlParameterInput> = MIXED_VALUES) {
  historyMocks.load.mockImplementation((key) => (values[key] ? [{ ...values[key] }] : []));
  const state = reactive({ open: true });
  const onExecute = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SqlParameterDialog, {
          open: state.open,
          sql: SQL,
          parameters: PARAMETERS,
          databaseType: "mysql",
          enabledSyntaxes: ["shell"],
          onExecute,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { state, onExecute };
}

function actionButton(): HTMLButtonElement | null {
  return document.body.querySelector('[data-testid="sql-parameters-use-raw-all"]');
}

function clearActionButton(): HTMLButtonElement | null {
  return document.body.querySelector('[data-testid="sql-parameters-clear-values"]');
}

function clickRawAction() {
  const button = actionButton();
  expect(button).not.toBeNull();
  button!.click();
}

function clickClearAction() {
  const button = clearActionButton();
  expect(button).not.toBeNull();
  button!.click();
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

function parameterInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[data-form-type="other"]'));
}

beforeEach(() => {
  historyMocks.load.mockReset();
  historyMocks.remember.mockReset();
  historyMocks.remember.mockImplementation((values) => Object.fromEntries(Object.entries(values).map(([key, input]) => [key, [{ ...input }]])));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SqlParameterDialog raw parameter action", () => {
  it("sets every displayed parameter to raw while preserving each current value", async () => {
    const { state, onExecute } = await mountDialog();
    const beforeValues = parameterInputs().map((input) => input.value);
    expect(parameterInputs()[2]?.disabled).toBe(true);

    clickRawAction();
    await nextTick();

    const inputs = parameterInputs();
    expect(inputs.map((input) => input.value)).toEqual(beforeValues);
    expect(inputs[2]?.disabled).toBe(false);
    expect(Array.from(document.body.querySelectorAll('[role="combobox"]')).map((trigger) => trigger.textContent?.trim())).toEqual(Array(PARAMETERS.length).fill("Raw SQL"));
    expect(document.body.querySelector("pre")?.textContent).toBe(RAW_SQL);
    expect(state.open).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("keeps the action idempotent when every displayed parameter is already raw", async () => {
    const { state, onExecute } = await mountDialog(RAW_VALUES);
    const beforeValues = parameterInputs().map((input) => input.value);
    const beforePreview = document.body.querySelector("pre")?.textContent;

    clickRawAction();
    await nextTick();

    expect(parameterInputs().map((input) => input.value)).toEqual(beforeValues);
    expect(document.body.querySelector("pre")?.textContent).toBe(beforePreview);
    expect(state.open).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("keeps cancel side-effect free after applying raw to all parameters", async () => {
    const { state, onExecute } = await mountDialog();

    clickRawAction();
    await nextTick();
    buttonWithText("Cancel")?.click();
    await nextTick();

    expect(state.open).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("remembers and emits the resolved SQL only when Execute is clicked", async () => {
    const { state, onExecute } = await mountDialog();

    clickRawAction();
    await nextTick();
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();

    buttonWithText("Execute")?.click();
    await nextTick();

    expect(historyMocks.remember).toHaveBeenCalledOnce();
    expect(historyMocks.remember).toHaveBeenCalledWith(RAW_VALUES);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(onExecute).toHaveBeenCalledWith(RAW_SQL);
    expect(state.open).toBe(false);
  });
});

describe("SqlParameterDialog clear parameter values action", () => {
  it("clears every displayed value while preserving kinds and updating the preview", async () => {
    const { state, onExecute } = await mountDialog();

    clickClearAction();
    await nextTick();

    expect(parameterInputs().map((input) => input.value)).toEqual(Array(PARAMETERS.length).fill(""));
    expect(Array.from(document.body.querySelectorAll('[role="combobox"]')).map((trigger) => trigger.textContent?.trim())).toEqual(["String", "Number", "NULL", "Raw SQL", "Boolean"]);
    expect(parameterInputs()[2]?.disabled).toBe(true);
    expect(document.body.querySelector("pre")?.textContent).toBe(CLEARED_SQL);
    expect(state.open).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("preserves parameter history after clearing current values", async () => {
    const { onExecute } = await mountDialog();

    clickClearAction();
    await nextTick();

    const input = parameterInputs()[0];
    expect(input).not.toBeUndefined();
    input?.focus();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const historyEntry = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("alpha beta"));
    expect(historyEntry).toBeDefined();
    historyEntry?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();

    expect(parameterInputs()[0]?.value).toBe("alpha beta");
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("keeps cancel side-effect free after clearing values", async () => {
    const { state, onExecute } = await mountDialog();

    clickClearAction();
    await nextTick();
    buttonWithText("Cancel")?.click();
    await nextTick();

    expect(state.open).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });

  it("remembers and emits cleared values only when Execute is clicked", async () => {
    const { state, onExecute } = await mountDialog();

    clickClearAction();
    await nextTick();
    expect(historyMocks.remember).not.toHaveBeenCalled();

    buttonWithText("Execute")?.click();
    await nextTick();

    expect(historyMocks.remember).toHaveBeenCalledOnce();
    expect(historyMocks.remember).toHaveBeenCalledWith(CLEARED_VALUES);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(onExecute).toHaveBeenCalledWith(CLEARED_SQL);
    expect(state.open).toBe(false);
  });

  it("is idempotent when the current parameter values are already empty", async () => {
    const { state, onExecute } = await mountDialog(CLEARED_VALUES);
    const beforePreview = document.body.querySelector("pre")?.textContent;

    clickClearAction();
    await nextTick();

    expect(parameterInputs().map((input) => input.value)).toEqual(Array(PARAMETERS.length).fill(""));
    expect(Array.from(document.body.querySelectorAll('[role="combobox"]')).map((trigger) => trigger.textContent?.trim())).toEqual(["String", "Number", "NULL", "Raw SQL", "Boolean"]);
    expect(document.body.querySelector("pre")?.textContent).toBe(beforePreview);
    expect(state.open).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
    expect(historyMocks.remember).not.toHaveBeenCalled();
  });
});
