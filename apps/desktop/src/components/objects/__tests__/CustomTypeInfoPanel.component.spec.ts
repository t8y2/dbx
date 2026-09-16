// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomTypeInfoPanel from "@/components/objects/CustomTypeInfoPanel.vue";
import type { ConnectionConfig, CustomTypeDetails } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getCustomTypeDetails: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getCustomTypeDetails: (...args: unknown[]) => mocks.getCustomTypeDetails(...args),
}));
vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => mocks.copyToClipboard(...args),
}));
vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return {
    Copy: Icon,
    RefreshCw: Icon,
    X: Icon,
  };
});

vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));

const connection: ConnectionConfig = {
  id: "pg-1",
  name: "pg",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "test",
  password: "secret",
  database: Some("demo"),
  visible_databases: null,
  visible_schemas: null,
  show_system_schemas: false,
  attached_databases: [],
  init_script: null,
  color: null,
  transport_layers: [],
  connection_string: null,
  driver_profile: null,
  driver_label: null,
  note: "",
  url_params: null,
  agent_java_options: [],
} as unknown as ConnectionConfig;

function Some<T>(value: T): T | null {
  return value;
}

function enumDetails(overrides: Partial<CustomTypeDetails> = {}): CustomTypeDetails {
  return {
    name: "status",
    schema: "app",
    kind: "enum",
    members: [
      { name: "", dataType: "", ordinal: 1, enumValue: "draft" },
      { name: "", dataType: "", ordinal: 2, enumValue: "published" },
    ],
    properties: { domainConstraints: [] },
    ddl: { sql: "CREATE TYPE \"app\".\"status\" AS ENUM ('draft', 'published');", complete: true, warnings: [] },
    ...overrides,
  };
}

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

function mountPanel(props: Record<string, unknown>) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(CustomTypeInfoPanel, props);
  app.mount(root);
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function clickButton(text: string) {
  const button = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  button?.dispatchEvent(new MouseEvent("click"));
  return button;
}

describe("CustomTypeInfoPanel", () => {
  it("shows loading while details are being fetched", async () => {
    let release!: () => void;
    mocks.getCustomTypeDetails.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await nextTick();
    expect(root!.textContent).toContain("common.loading");
    release();
  });

  it("renders enum values and complete DDL", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    expect(root!.textContent).toContain("draft");
    expect(root!.textContent).toContain("published");
  });

  it("shows the explanatory empty state for an enum with no values", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ members: [] }));
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    expect(root!.textContent).toContain("customType.members.empty");
  });

  it("shows the explanatory empty state for a composite with no fields", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ kind: "composite", members: [], ddl: { sql: "CREATE TYPE ...;", complete: true, warnings: [] } }));
    mountPanel({ connection, database: "demo", schema: "app", name: "address" });
    await flush();
    expect(root!.textContent).toContain("customType.members.empty");
  });

  it("shows DDL warnings when the DDL is incomplete", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        ddl: { sql: "", complete: false, warnings: ["multirange companion; no standalone CREATE"] },
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "_price_range" });
    await flush();
    const ddlButton = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent === "customType.tabs.ddl");
    ddlButton?.dispatchEvent(new MouseEvent("click"));
    await nextTick();
    expect(root!.textContent).toContain("multirange companion; no standalone CREATE");
  });

  it("hides kernel-level type implementation attributes", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "base",
        members: [],
        properties: {
          domainConstraints: [],
          inputFunction: "base_in",
          alignment: "i",
          storage: "x",
        },
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "base_type" });
    await flush();
    expect(clickButton("customType.tabs.members")).toBeUndefined();
    expect(root!.textContent).toContain("customType.tabs.properties");
    expect(root!.textContent).not.toContain("base_in");
    expect(root!.textContent).not.toContain("customType.properties.alignment");
    expect(root!.textContent).not.toContain("customType.properties.storage");
  });

  it("renders an error state with a working retry button", async () => {
    mocks.getCustomTypeDetails.mockRejectedValueOnce(new Error("catalog unavailable"));
    mocks.getCustomTypeDetails.mockResolvedValueOnce(enumDetails());
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    expect(root!.textContent).toContain("catalog unavailable");
    clickButton("common.retry");
    await vi.waitFor(() => expect(root!.textContent).toContain("draft"));
  });

  it("reports copy success through the toast", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.copyToClipboard.mockResolvedValue(undefined);
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    clickButton("customType.tabs.ddl");
    await flush();
    clickButton("grid.copyDdl");
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("CREATE TYPE \"app\".\"status\" AS ENUM ('draft', 'published');"));
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.ddlCopied");
  });

  it("reports copy failure through the toast", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.copyToClipboard.mockRejectedValue(new Error("denied"));
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    clickButton("customType.tabs.ddl");
    await flush();
    clickButton("grid.copyDdl");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("grid.copyFailed"));
  });

  it("ignores a stale response when the type is switched quickly on the same instance", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<CustomTypeDetails>((resolve) => (releaseFirst = () => resolve(enumDetails({ name: "status" }))));
    const second = Promise.resolve(enumDetails({ name: "email", kind: "domain", members: [], properties: { baseType: "text", domainConstraints: [] } }));
    mocks.getCustomTypeDetails.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const hostName = ref("status");
    const Host = defineComponent({
      setup() {
        return () => h(CustomTypeInfoPanel, { connection, database: "demo", schema: "app", name: hostName.value });
      },
    });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Host);
    app.mount(root);

    await nextTick();
    hostName.value = "email";
    await nextTick();
    releaseFirst();
    await flush();

    // The stale "status" response must not overwrite the "email" details.
    expect(root!.textContent).toContain("email");
    expect(root!.textContent).not.toContain("draft");
  });
});
