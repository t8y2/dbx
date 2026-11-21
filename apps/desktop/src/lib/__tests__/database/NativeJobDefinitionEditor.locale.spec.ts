// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import { expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN";
import NativeJobDefinitionEditor from "@/components/admin/NativeJobDefinitionEditor.vue";
import type { NativeJobDefinitionDraft } from "@/lib/database/nativeJobAdmin";
import type { NativeJobDetails } from "@/lib/database/nativeJobs";

vi.mock("@/lib/backend/api", () => ({ nativeJobReferences: vi.fn() }));

it("allows DM named replacement without exposing inline attachment, detach or Oracle trigger categories", async () => {
  for (const named of [true, false]) {
    const details = {
      snapshot: {
        ref: { kind: "scheduler" },
        revision: "read",
        definition: {
          status: "available",
          value: {
            PROGRAM_OWNER: named ? "Owner" : null,
            PROGRAM_NAME: named ? "P1" : null,
            SCHEDULE_OWNER: named ? "Owner" : null,
            SCHEDULE_NAME: named ? "S1" : null,
            SCHEDULE_TYPE: "CALENDAR",
            JOB_TYPE: "STORED_PROCEDURE",
            JOB_ACTION: "proc",
            NUMBER_OF_ARGUMENTS: 0,
          },
        },
        arguments: { status: "available", value: [] },
      },
    } as NativeJobDetails;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(NativeJobDefinitionEditor, { engine: "dameng", kind: "scheduler", details, modelValue: {} });
    app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
    try {
      app.mount(root);
      await nextTick();
      for (const label of ["程序名称", "调度名称"]) expect(root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.disabled).toBe(!named);
      expect([...root.querySelectorAll("button")].some((button) => button.textContent?.trim() === "选择程序")).toBe(named);
      expect([...root.querySelectorAll("button")].some((button) => button.textContent?.trim() === "选择调度")).toBe(named);
      expect(root.querySelector('option[value="window"]')).toBeNull();
      expect(root.querySelector('option[value="file-watcher"]')).toBeNull();
      for (const input of root.querySelectorAll('[aria-label="程序名称"], [aria-label="调度名称"]')) {
        expect(input.closest("div")?.textContent).not.toContain("NULL");
      }
    } finally {
      app.unmount();
      root.remove();
    }
  }
});

it("renders advanced labels, reference choices and enum labels in Chinese while retaining native values", async () => {
  const scope = { connectionId: "c", database: "", contextId: "ctx" };
  const details = {
    snapshot: {
      ref: { scope, kind: "scheduler", owner: "Owner", name: "Job" },
      revision: "read",
      definition: {
        status: "available",
        value: {
          ENABLED: false,
          JOB_TYPE: "STORED_PROCEDURE",
          JOB_ACTION: "proc",
          NUMBER_OF_ARGUMENTS: 0,
          PROGRAM_OWNER: null,
          PROGRAM_NAME: null,
          SCHEDULE_OWNER: null,
          SCHEDULE_NAME: null,
          JOB_CLASS: "DEFAULT_JOB_CLASS",
          CREDENTIAL_OWNER: null,
          CREDENTIAL_NAME: null,
          CONNECT_CREDENTIAL_OWNER: null,
          CONNECT_CREDENTIAL_NAME: null,
          DESTINATION_OWNER: null,
          DESTINATION: "exact.host:1500",
          LOGGING_LEVEL: "RUNS",
        },
      },
      arguments: { status: "available", value: [] },
    },
  } as NativeJobDetails;
  const draft = ref<NativeJobDefinitionDraft>({});
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(defineComponent({ setup: () => () => h(NativeJobDefinitionEditor, { engine: "oracle", kind: "scheduler", scope, details, modelValue: draft.value, "onUpdate:modelValue": (value: NativeJobDefinitionDraft) => (draft.value = value) }) }));
  app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
  const button = (label: string) => {
    const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };
  try {
    app.mount(root);
    button("高级属性").click();
    await nextTick();
    for (const label of [
      "作业类",
      "优先级",
      "最多运行次数",
      "最多失败次数",
      "最长运行时长",
      "调度延迟上限",
      "允许重新启动",
      "窗口关闭时停止",
      "保存运行输出",
      "允许在受限模式运行",
      "实例亲和性",
      "跟随默认时区",
      "执行实例",
      "作业权重",
      "触发事件掩码",
      "连接凭据",
      "运行凭据",
      "远程主机 (host[:port])",
      "日志记录级别",
    ]) {
      expect(root.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
    expect(root.querySelector<HTMLInputElement>('[aria-label="作业类"]')!.value).toBe("DEFAULT_JOB_CLASS");
    const logging = root.querySelector<HTMLSelectElement>('[aria-label="日志记录级别"]')!;
    expect([...logging.options].map((option) => [option.value, option.textContent])).toEqual([
      ["OFF", "不记录"],
      ["RUNS", "运行记录"],
      ["FAILED RUNS", "仅记录失败"],
      ["FULL", "完整记录"],
    ]);
    const mode = root.querySelector<HTMLSelectElement>('[aria-label="执行目标"]')!;
    mode.value = "named";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(root.querySelector('[aria-label="命名目的地"]')).not.toBeNull();
    expect(button("选择凭据")).toBeDefined();
    expect(button("选择目的地")).toBeDefined();
    expect(button("选择目的地组")).toBeDefined();
    button("作业定义").click();
    await nextTick();
    const type = root.querySelector<HTMLSelectElement>('[aria-label="作业类型"]')!;
    expect([...type.options].find((option) => option.value === "STORED_PROCEDURE")?.textContent).toBe("存储过程");
    expect([...type.options].find((option) => option.value === "PLSQL_BLOCK")?.textContent).toBe("PL/SQL 块");
    expect(button("选择程序")).toBeDefined();
    expect(button("选择调度")).toBeDefined();
  } finally {
    app.unmount();
    root.remove();
  }
});

it("activates a typed argument without stringifying its envelope and keeps typed NULL as a value", async () => {
  const number = { $dbx: "oracle-anydata-v1", typeName: "SYS.NUMBER", value: "9007199254740993.123456789" };
  const typedNull = { $dbx: "oracle-anydata-v1", scalarType: "char", value: null };
  const details = {
    snapshot: {
      ref: { kind: "scheduler" },
      revision: "read",
      definition: { status: "available", value: { JOB_STYLE: "REGULAR" } },
      arguments: {
        status: "available",
        value: [
          { position: 1, dataType: "NUMBER", value: { kind: "value", value: number }, editable: true },
          { position: 2, dataType: "VARCHAR2", value: { kind: "value", value: typedNull }, editable: true },
        ],
      },
    },
  } as NativeJobDetails;
  const draft = ref<NativeJobDefinitionDraft>({});
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(defineComponent({ setup: () => () => h(NativeJobDefinitionEditor, { engine: "oracle", kind: "scheduler", details, modelValue: draft.value, "onUpdate:modelValue": (value: NativeJobDefinitionDraft) => (draft.value = value) }) }));
  app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
  try {
    app.mount(root);
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "参数")!.click();
    await nextTick();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="参数 1 的值"]')!.value).toBe(number.value);
    for (const position of [1, 2]) {
      const state = root.querySelector<HTMLSelectElement>(`[aria-label="参数 ${position} 的状态"]`)!;
      state.value = "value";
      state.dispatchEvent(new Event("change", { bubbles: true }));
      await nextTick();
    }
    expect(draft.value.arguments).toEqual([
      { position: 1, value: { kind: "value", value: number } },
      { position: 2, value: { kind: "value", value: typedNull } },
    ]);
    const numberInput = root.querySelector<HTMLTextAreaElement>('[aria-label="参数 1 的值"]')!;
    numberInput.value = "-1.000000000000000000000000000000000001";
    numberInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(draft.value.arguments![0]!.value).toEqual({ kind: "value", value: { $dbx: "oracle-anydata-v1", scalarType: "number", value: numberInput.value } });
    expect(root.textContent).not.toContain('"$dbx"');
    expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]:checked')).not.toBeNull();
  } finally {
    app.unmount();
    root.remove();
  }
});
