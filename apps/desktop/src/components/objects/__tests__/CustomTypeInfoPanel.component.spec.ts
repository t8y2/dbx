// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomTypeInfoPanel from "@/components/objects/CustomTypeInfoPanel.vue";
import type { ConnectionConfig, CustomTypeDetails } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getCustomTypeDetails: vi.fn(),
  getObjectSource: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getCustomTypeDetails: (...args: unknown[]) => mocks.getCustomTypeDetails(...args),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
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

vi.mock("vue-i18n", async () => {
  const { default: english } = await import("@/i18n/locales/en");
  return {
    useI18n: () => ({
      t: (key: string) => {
        if (key === "oracleType.boolean.yes") return english.oracleType.boolean.yes;
        if (key === "oracleType.boolean.no") return english.oracleType.boolean.no;
        return key;
      },
    }),
  };
});
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

  it("renders Oracle attributes and incomplete method metadata without claiming an empty method list", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "object",
        members: [],
        ddl: null,
        oracleMetadata: {
          typeCode: "OBJECT",
          status: "VALID",
          attributeCount: 1,
          methodCount: 1,
          bodyVisible: true,
          bodyStatus: "VALID",
          propertiesRead: { state: "available" },
          bodyRead: { state: "available" },
          attributesRead: { state: "available" },
          methodsRead: { state: "incomplete", reason: "Dictionary count is 1 but no method row was returned." },
          collectionRead: { state: "unsupported" },
          attributes: [{ name: "street", ordinal: 1, typeName: "VARCHAR2", length: 80 }],
          methods: [
            {
              name: "SET_STREET",
              parameters: [{ name: "P_STREET", mode: "IN", typeName: "VARCHAR2" }],
              results: [{ name: "RETURN_VALUE", typeName: "BOOLEAN" }],
              parametersRead: { state: "incomplete", reason: "One argument row is unavailable." },
              resultsRead: { state: "incomplete", reason: "Result metadata is partial." },
            },
          ],
        },
      }),
    );
    mocks.getObjectSource.mockResolvedValue({ source: "CREATE TYPE BODY app.address_type AS ...;", editable: false });
    mountPanel({ connection, database: "demo", schema: "app", name: "address_type", databaseType: "oracle" });
    await flush();
    expect(root!.textContent).toContain("street");
    expect(root!.textContent).toContain("VARCHAR2");
    clickButton("oracleType.methods");
    await flush();
    expect(root!.textContent).toContain("Dictionary count is 1 but no method row was returned.");
    expect(root!.textContent).not.toContain("oracleType.emptyMethods");
    expect(root!.textContent).toContain("P_STREET");
    expect(root!.textContent).toContain("One argument row is unavailable.");
    expect(root!.textContent).toContain("RETURN_VALUE");
    expect(root!.textContent).toContain("Result metadata is partial.");
    clickButton("customType.tabs.properties");
    await flush();
    clickButton("oracleType.viewBody");
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledWith("pg-1", "demo", "app", "address_type", "TYPE_BODY"));
    await vi.waitFor(() => expect(root!.textContent).toContain("CREATE TYPE BODY"));
    expect(root!.textContent).toContain("CREATE TYPE BODY");
  });

  it("uses real locale strings for Oracle boolean properties", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "object",
        members: [],
        ddl: null,
        oracleMetadata: {
          isFinal: true,
          instantiable: false,
          propertiesRead: { state: "available" },
          bodyRead: { state: "unsupported" },
          attributesRead: { state: "available" },
          methodsRead: { state: "available" },
          collectionRead: { state: "unsupported" },
          attributes: [],
          methods: [],
        },
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "status", databaseType: "oracle" });
    await flush();
    clickButton("customType.tabs.properties");
    await flush();
    expect(root!.textContent).toContain("Yes");
    expect(root!.textContent).toContain("No");
    expect(root!.textContent).not.toContain("common.yes");
    expect(root!.textContent).not.toContain("common.no");
  });

  it("shows collection element length and dictionary visibility, and preserves details during refresh", async () => {
    const collectionDetails = enumDetails({
      kind: "collection",
      members: [],
      ddl: null,
      oracleMetadata: {
        status: undefined,
        bodyVisible: false,
        bodyRead: { state: "available" },
        propertiesRead: { state: "available" },
        attributesRead: { state: "available" },
        methodsRead: { state: "unavailable", reason: "Methods are not visible." },
        collectionRead: { state: "unavailable", reason: "Collection metadata is not visible." },
        collection: { kind: "VARRAY", elementName: "VARCHAR2", length: 30, upperBound: 10 },
        attributes: [],
        methods: [],
      },
    });
    mocks.getCustomTypeDetails.mockResolvedValueOnce(collectionDetails);
    let releaseRefresh!: (value: CustomTypeDetails) => void;
    mocks.getCustomTypeDetails.mockReturnValueOnce(new Promise((resolve) => (releaseRefresh = resolve)));
    mountPanel({ connection, database: "demo", schema: "app", name: "name_list", databaseType: "oracle" });
    await flush();
    expect(root!.textContent).toContain("oracleType.length: 30");
    expect(root!.textContent).toContain("oracleType.bodyNotVisible");
    expect(root!.textContent).toContain("oracleType.unknown");
    expect(root!.textContent).toContain("Collection metadata is not visible.");
    expect(root!.textContent).not.toContain("oracleType.emptyAttributes");

    clickButton("oracleType.methods");
    await flush();
    expect(root!.textContent).toContain("Methods are not visible.");
    const refresh = root!.querySelector<HTMLButtonElement>('button[aria-label="common.retry"]');
    refresh?.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(2);
    expect(root!.textContent).toContain("Methods are not visible.");
    expect(root!.textContent).not.toContain("Cannot read properties");
    clickButton("customType.tabs.properties");
    await flush();
    expect(root!.textContent).toContain("oracleType.length: 30");
    releaseRefresh(collectionDetails);
    await flush();
  });

  it("refreshes Oracle details and current source while discarding both older responses", async () => {
    const oracleDetails = enumDetails({
      kind: "object",
      members: [],
      ddl: null,
      oracleMetadata: {
        propertiesRead: { state: "available" },
        bodyRead: { state: "unsupported" },
        attributesRead: { state: "available" },
        methodsRead: { state: "available" },
        collectionRead: { state: "unsupported" },
        attributes: [{ name: "street", ordinal: 1, typeName: "VARCHAR2", length: 30 }],
        methods: [],
      },
    });
    mocks.getCustomTypeDetails.mockResolvedValueOnce(oracleDetails);
    mocks.getObjectSource.mockResolvedValueOnce({ source: "OLD_TYPE_SOURCE", editable: false });
    const panel = ref<InstanceType<typeof CustomTypeInfoPanel> | null>(null);
    const Host = defineComponent({
      setup() {
        return () => h(CustomTypeInfoPanel, { ref: panel, connection, database: "demo", schema: "app", name: "address_type", databaseType: "oracle" });
      },
    });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Host);
    app.mount(root);
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(1));
    clickButton("oracleType.source");
    await vi.waitFor(() => expect(root!.textContent).toContain("OLD_TYPE_SOURCE"));
    clickButton("customType.tabs.members");
    await flush();
    expect(root!.textContent).toContain("street");
    clickButton("oracleType.source");
    await flush();

    let releaseOldDetails!: (value: CustomTypeDetails) => void;
    let releaseFreshDetails!: (value: CustomTypeDetails) => void;
    let releaseOldSource!: (value: { source: string; editable: boolean }) => void;
    let releaseFreshSource!: (value: { source: string; editable: boolean }) => void;
    mocks.getCustomTypeDetails.mockReturnValueOnce(new Promise((resolve) => (releaseOldDetails = resolve))).mockReturnValueOnce(new Promise((resolve) => (releaseFreshDetails = resolve)));
    mocks.getObjectSource.mockReturnValueOnce(new Promise((resolve) => (releaseOldSource = resolve))).mockReturnValueOnce(new Promise((resolve) => (releaseFreshSource = resolve)));

    const refreshButton = root!.querySelector<HTMLButtonElement>('button[aria-label="common.retry"]');
    refreshButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await panel.value?.refresh();
    await vi.waitFor(() => {
      expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(3);
      expect(mocks.getObjectSource).toHaveBeenCalledTimes(3);
    });
    clickButton("customType.tabs.members");
    await flush();
    expect(root!.textContent).toContain("street");
    clickButton("oracleType.source");
    await flush();
    expect(root!.textContent).toContain("OLD_TYPE_SOURCE");

    releaseOldDetails(enumDetails({ name: "stale_type" }));
    releaseOldSource({ source: "STALE_TYPE_SOURCE", editable: false });
    await flush();
    expect(root!.textContent).not.toContain("STALE_TYPE_SOURCE");
    expect(root!.textContent).not.toContain("stale_type");
    releaseFreshDetails(oracleDetails);
    releaseFreshSource({ source: "FRESH_TYPE_SOURCE", editable: false });
    await vi.waitFor(() => expect(root!.textContent).toContain("FRESH_TYPE_SOURCE"));
    clickButton("customType.tabs.members");
    await flush();
    expect(root!.textContent).toContain("street");
    expect(root!.textContent).not.toContain("STALE_TYPE_SOURCE");
    expect(root!.textContent).not.toContain("stale_type");
  });

  it("keeps type details visible when Oracle source reading fails and retries only source", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "object",
        members: [],
        ddl: null,
        oracleMetadata: {
          typeCode: "OBJECT",
          propertiesRead: { state: "available" },
          bodyRead: { state: "unsupported" },
          attributesRead: { state: "available" },
          methodsRead: { state: "available" },
          collectionRead: { state: "unsupported" },
          attributes: [],
          methods: [],
        },
      }),
    );
    mocks.getObjectSource.mockRejectedValueOnce(new Error("source dictionary denied")).mockResolvedValueOnce({ source: "CREATE TYPE app.status AS OBJECT (...);", editable: false });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", databaseType: "oceanbase-oracle" });
    await flush();
    clickButton("oracleType.source");
    await flush();
    expect(root!.textContent).toContain("source dictionary denied");
    clickButton("customType.tabs.properties");
    await flush();
    expect(root!.textContent).toContain("app");
    clickButton("oracleType.source");
    await flush();
    const sourceRetry = root!.querySelector("section button");
    expect(sourceRetry?.textContent).toContain("common.retry");
    sourceRetry?.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root!.textContent).toContain("CREATE TYPE app.status"));
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(1);
  });

  it("loads Oracle source even when type metadata fails", async () => {
    mocks.getCustomTypeDetails.mockRejectedValue(new Error("metadata unavailable"));
    mocks.getObjectSource.mockResolvedValue({ source: "CREATE TYPE app.status AS OBJECT (...);", editable: false });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", databaseType: "dameng" });
    await vi.waitFor(() => expect(root!.textContent).toContain("CREATE TYPE app.status"));
    expect(root!.textContent).toContain("metadata unavailable");
    expect(mocks.getObjectSource).toHaveBeenCalledWith("pg-1", "demo", "app", "status", "TYPE");
  });

  it("discards a late Oracle source result after the selected type changes", async () => {
    const oracleDetails = enumDetails({
      kind: "object",
      members: [],
      ddl: null,
      oracleMetadata: {
        propertiesRead: { state: "available" },
        bodyRead: { state: "unsupported" },
        attributesRead: { state: "available" },
        methodsRead: { state: "available" },
        collectionRead: { state: "unsupported" },
        attributes: [],
        methods: [],
      },
    });
    mocks.getCustomTypeDetails.mockResolvedValue(oracleDetails);
    let releaseFirst!: (value: { source: string; editable: boolean }) => void;
    mocks.getObjectSource.mockReturnValueOnce(new Promise((resolve) => (releaseFirst = resolve))).mockResolvedValueOnce({ source: "FRESH_TYPE_SOURCE", editable: false });
    const hostName = ref("first_type");
    const Host = defineComponent({
      setup() {
        return () => h(CustomTypeInfoPanel, { connection, database: "demo", schema: "app", name: hostName.value, databaseType: "oracle" });
      },
    });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Host);
    app.mount(root);
    await flush();
    hostName.value = "second_type";
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(2));
    clickButton("oracleType.source");
    await vi.waitFor(() => expect(root!.textContent).toContain("FRESH_TYPE_SOURCE"));
    releaseFirst({ source: "STALE_TYPE_SOURCE", editable: false });
    await flush();
    expect(root!.textContent).toContain("second_type");
    expect(root!.textContent).not.toContain("STALE_TYPE_SOURCE");
  });

  it("keeps an explicitly selected tab when details finish loading", async () => {
    let release!: (details: CustomTypeDetails) => void;
    mocks.getCustomTypeDetails.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const panel = ref<InstanceType<typeof CustomTypeInfoPanel> | null>(null);
    const Host = defineComponent({
      setup() {
        return () => h(CustomTypeInfoPanel, { ref: panel, connection, database: "demo", schema: "app", name: "status" });
      },
    });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Host);
    app.mount(root);
    await nextTick();
    panel.value?.selectTab("ddl");
    release(enumDetails());
    await flush();
    expect(root!.querySelector("pre")?.textContent).toContain("CREATE TYPE");
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
