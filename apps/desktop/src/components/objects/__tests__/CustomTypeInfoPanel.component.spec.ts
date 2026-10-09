// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomTypeInfoPanel from "@/components/objects/CustomTypeInfoPanel.vue";
import RetainedKeepAlive from "@/components/layout/RetainedKeepAlive";
import type { ConnectionConfig, CustomTypeChangePreview, CustomTypeDetails, CustomTypeEditorSession, CustomTypeDropPreview, CustomTypeManagementCapabilities } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getCustomTypeDetails: vi.fn(),
  getCustomTypeManagementCapabilities: vi.fn(),
  listDataTypes: vi.fn(),
  executeQuery: vi.fn(),
  previewCustomTypeChange: vi.fn(),
  applyCustomTypeChange: vi.fn(),
  previewCustomTypeDrop: vi.fn(),
  applyCustomTypeDrop: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getCustomTypeDetails: (...args: unknown[]) => mocks.getCustomTypeDetails(...args),
  getCustomTypeManagementCapabilities: (...args: unknown[]) => mocks.getCustomTypeManagementCapabilities(...args),
  listDataTypes: (...args: unknown[]) => mocks.listDataTypes(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  previewCustomTypeChange: (...args: unknown[]) => mocks.previewCustomTypeChange(...args),
  applyCustomTypeChange: (...args: unknown[]) => mocks.applyCustomTypeChange(...args),
  previewCustomTypeDrop: (...args: unknown[]) => mocks.previewCustomTypeDrop(...args),
  applyCustomTypeDrop: (...args: unknown[]) => mocks.applyCustomTypeDrop(...args),
}));
vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => mocks.copyToClipboard(...args),
}));
vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
// The production guard asks the (pinia-backed) safety store for confirmation;
// these tests only need the guard to be transparent.
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: async <T>(options: { execute: () => Promise<T> }) => options.execute(),
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
    Check: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    Copy: Icon,
    Loader2: Icon,
    Pencil: Icon,
    Plus: Icon,
    ArrowDown: Icon,
    ArrowUp: Icon,
    RefreshCw: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    inheritAttrs: false,
    props: { modelValue: String, options: Array, disabled: Boolean },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () =>
        h(
          "select",
          {
            ...attrs,
            value: props.modelValue,
            disabled: props.disabled,
            onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
          },
          (props.options as string[]).map((option) => h("option", { value: option }, option)),
        );
    },
  }),
}));
// A component-level `v-model` compiles to `modelValue` + `update:modelValue`, so
// a plain passthrough would never report a typed value.
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () =>
        h("input", {
          ...attrs,
          value: props.modelValue,
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
        });
    },
  }),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: Boolean, default: false } },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () => h("input", { ...attrs, type: "checkbox", checked: props.modelValue, onChange: () => emit("update:modelValue", !props.modelValue) });
    },
  }),
}));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: defineComponent({
    inheritAttrs: false,
    props: {
      open: { type: Boolean, default: false },
      title: { type: String, default: "" },
      sql: { type: String, default: "" },
      message: { type: String, default: "" },
      loading: { type: Boolean, default: false },
      confirmDisabled: { type: Boolean, default: false },
      closeOnConfirm: { type: Boolean, default: true },
    },
    emits: ["confirm", "update:open"],
    setup(props, { slots, emit }) {
      // Mirrors the real dialog's two load-bearing behaviours: it refuses a close
      // request while `loading`, and it closes itself on confirm
      // (`closeOnConfirm` defaults to true). Both matter here — the reviewed bug
      // was a `loading` value that was already true when the dialog opened, which
      // locked confirmation, cancellation and closing all at once.
      const requestClose = () => {
        if (props.loading) return;
        emit("update:open", false);
      };
      return () => {
        if (!props.open) return h("span");
        return h(
          "div",
          {
            class: "danger-dialog",
            "data-title": props.title,
            "data-message": props.message,
            "data-sql": props.sql,
            "data-loading": String(props.loading),
          },
          [
            h(
              "button",
              {
                class: "danger-confirm",
                disabled: props.loading || props.confirmDisabled,
                onClick: () => {
                  if (props.loading || props.confirmDisabled) return;
                  if (props.closeOnConfirm) requestClose();
                  emit("confirm");
                },
              },
              "danger-confirm",
            ),
            h(
              "button",
              {
                class: "danger-cancel",
                disabled: props.loading,
                onClick: requestClose,
              },
              "danger-cancel",
            ),
            slots.options?.(),
          ],
        );
      };
    },
  }),
}));

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

function capabilities(overrides: Partial<Record<string, boolean>> = {}): CustomTypeManagementCapabilities {
  const supported = [
    "create.enum",
    "create.composite",
    "create.domain",
    "create.range",
    "alter.rename",
    "alter.setSchema",
    "alter.owner",
    "alter.comment",
    "alter.enum.addValue",
    "alter.enum.renameValue",
    "alter.composite.addAttribute",
    "alter.composite.renameAttribute",
    "alter.composite.alterAttributeType",
    "alter.composite.dropAttribute",
    "alter.domain.default",
    "alter.domain.notNull",
    "alter.domain.addConstraint",
    "alter.domain.renameConstraint",
    "alter.domain.dropConstraint",
    "alter.domain.validateConstraint",
    "drop.restrict",
    "drop.cascade",
    "transactionalDdl",
  ];
  const operations: CustomTypeManagementCapabilities["operations"] = {};
  for (const operation of supported) {
    operations[operation as keyof typeof operations] = { supported: overrides[operation] !== false };
  }
  return {
    databaseType: "postgres",
    productVersion: "16.0",
    compatibilityMode: null,
    operations,
    capabilityRevision: "cap-1",
  };
}

function preview(overrides: Partial<CustomTypeChangePreview> = {}): CustomTypeChangePreview {
  return {
    statements: ['CREATE TYPE "app"."status" AS ENUM (\'draft\');'],
    warnings: [],
    blockedChanges: [],
    destructive: false,
    transactionPolicy: "autocommit",
    planRevision: "rev-1",
    resultingIdentity: { schema: "app", name: "status", kind: "enum" },
    ...overrides,
  };
}

function dropPreview(overrides: Partial<CustomTypeDropPreview> = {}): CustomTypeDropPreview {
  return {
    statement: 'DROP TYPE "app"."status" RESTRICT;',
    dependencies: [],
    dependenciesComplete: true,
    warnings: [],
    blockedChanges: [],
    planRevision: "drop-rev-1",
    ...overrides,
  };
}

function enumDetails(overrides: Partial<CustomTypeDetails> = {}): CustomTypeDetails {
  return {
    snapshotRevision: "snapshot-1",
    name: "status",
    schema: "app",
    kind: "enum",
    comment: null,
    owner: "app_owner",
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

function mountCachedPanel(initialMode: "edit" | "delete" = "edit") {
  const active = ref(0);
  const session = ref<CustomTypeEditorSession | null>(null);
  const closed = ref(false);
  const request = ref({ schema: "app", name: "status", initialMode: initialMode as "view" | "edit" | "delete" });
  const dirty = vi.fn();
  const saved = vi.fn((payload: { identity: { schema: string; name: string } }) => {
    request.value = { ...payload.identity, initialMode: "view" };
  });
  const deleted = vi.fn(() => {
    closed.value = true;
    session.value = null;
  });
  // The event-owning parent must survive too, just as ContentArea/ObjectBrowser
  // must remain mounted to publish the final session to the tab store.
  const Surface = defineComponent({
    setup: () => () =>
      closed.value
        ? h("div", "type deleted")
        : h(CustomTypeInfoPanel, {
            connection,
            database: "demo",
            ...request.value,
            session: session.value,
            onSessionChange: (value: CustomTypeEditorSession) => {
              session.value = value;
            },
            onDirtyChange: dirty,
            onSaved: saved,
            onDeleted: deleted,
          }),
  });
  const Dummy = defineComponent({ render: () => h("div", "other tab") });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    setup: () => () =>
      h(
        RetainedKeepAlive,
        { max: 3, cacheKey: String(active.value) },
        {
          default: () => (active.value === 0 ? h(Surface, { key: "type" }) : h(Dummy, { key: `other:${active.value}` })),
        },
      ),
  });
  app.mount(root);
  return { active, session, dirty, saved, deleted };
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
  mocks.getCustomTypeManagementCapabilities.mockResolvedValue(capabilities());
  mocks.listDataTypes.mockResolvedValue(["text", "numeric"]);
  mocks.executeQuery.mockResolvedValue({ columns: ["user", "host", "plugin"], rows: [] });
  mocks.previewCustomTypeChange.mockResolvedValue(preview());
  mocks.previewCustomTypeDrop.mockResolvedValue(dropPreview());
});

async function flush(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

function clickButton(text: string) {
  const button = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  button?.dispatchEvent(new MouseEvent("click"));
  return button;
}

/** Icon-only buttons have no text, so they are found by their tooltip title. */
function iconButton(title: string) {
  return Array.from(root!.querySelectorAll("button")).find((b) => b.getAttribute("title") === title);
}

function clickIconButton(title: string) {
  const button = iconButton(title);
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

describe("CustomTypeInfoPanel designer", () => {
  it("loads and offers owner roles when switching from view to edit", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.executeQuery.mockResolvedValue({ columns: ["user", "host", "plugin"], rows: [["new_owner", "ROLE", ""]] });
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(clickIconButton("customType.editor.edit")).toBeDefined();
    await flush();
    expect(mocks.executeQuery).toHaveBeenCalledWith("pg-1", "demo", expect.stringContaining("pg_catalog.pg_roles"), undefined, undefined, { maxRows: 5000 });
    const ownerSelect = root!.querySelector<HTMLSelectElement>('[aria-label="customType.properties.owner"]')!;
    expect(Array.from(ownerSelect.options, (option) => option.value)).toEqual(["app_owner", "new_owner"]);
    ownerSelect.value = "new_owner";
    ownerSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(mocks.previewCustomTypeChange.mock.calls.at(-1)![2].draft.owner).toBe("new_owner"));
  });

  it.each([false, true])("uses saved domain validation state (%s) even after renaming a constraint", async (validated) => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "domain",
        members: [],
        properties: {
          baseType: "integer",
          notNull: false,
          domainConstraints: [{ name: "positive", definition: "CHECK (VALUE > 0)", validated }],
        },
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "positive_int", initialMode: "edit" });
    await flush();
    const name = root!.querySelector<HTMLInputElement>('[aria-label="constraint 1 name"]')!;
    name.value = "renamed_positive";
    name.dispatchEvent(new Event("input"));
    await flush();
    const checkbox = root!.querySelector<HTMLInputElement>('label input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(validated);
    expect(checkbox.disabled).toBe(validated);
    expect(checkbox.parentElement!.title).toBe(validated ? "customType.editor.constraintAlreadyValidated" : "");
    if (!validated) {
      checkbox.click();
      await flush();
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(false);
      expect(checkbox.parentElement!.title).toBe("");
      checkbox.click();
      await flush();
      expect(checkbox.checked).toBe(false);
      await vi.waitFor(() =>
        expect(mocks.previewCustomTypeChange.mock.calls.at(-1)![2].draft.definition.constraints[0]).toMatchObject({
          name: "renamed_positive",
          originalName: "positive",
          validated: false,
        }),
      );
    }
  });

  it.each(["create", "edit"])("keeps validation reversible for new domain constraints in %s mode", async (initialMode) => {
    mocks.getCustomTypeDetails.mockResolvedValue(
      enumDetails({
        kind: "domain",
        members: [],
        properties: { baseType: "integer", domainConstraints: [] },
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "positive_int", initialMode });
    await flush();
    if (initialMode === "create") {
      const kind = root!.querySelector<HTMLSelectElement>('[aria-label="customType.editor.kind"]')!;
      kind.value = "domain";
      kind.dispatchEvent(new Event("change"));
      await flush();
    }
    root!.querySelector<HTMLButtonElement>("fieldset button")!.click();
    await flush();
    const checkbox = root!.querySelector<HTMLInputElement>('label input[type="checkbox"]')!;
    for (const checked of [true, false, true]) {
      expect(checkbox.checked).toBe(checked);
      expect(checkbox.disabled).toBe(false);
      expect(checkbox.parentElement!.title).toBe("");
      checkbox.click();
      await flush();
    }
  });

  it("offers no edit or delete entry on a read-only connection", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mountPanel({ connection: { ...connection, read_only: true }, database: "demo", schema: "app", name: "status" });
    await flush();
    expect(clickButton("customType.editor.edit")).toBeUndefined();
    expect(clickButton("customType.editor.delete")).toBeUndefined();
    expect(root!.textContent).toContain("customType.editor.readOnlyConnection");
  });

  it("starts a create draft and previews it", async () => {
    mountPanel({ connection, database: "demo", schema: "app", name: "", initialMode: "create", requestId: 1 });
    await flush();
    expect(root!.textContent).toContain("customType.editor.newTitle");
    await vi.waitFor(() => expect(mocks.previewCustomTypeChange).toHaveBeenCalled());
    const request = mocks.previewCustomTypeChange.mock.calls.at(-1)![2];
    expect(request.target).toBeNull();
    expect(request.draft.schema).toBe("app");
    expect(request.draft.definition.kind).toBe("enum");
  });

  it("blocks saving while the plan has blocking issues", async () => {
    mocks.previewCustomTypeChange.mockResolvedValue(
      preview({
        statements: [],
        blockedChanges: [{ code: "identity.name_taken", message: "A type named app.status already exists.", severity: "blocking" }],
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "", initialMode: "create", requestId: 1 });
    await flush();
    const saveButton = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.includes("structureEditor.save"));
    expect(saveButton).toBeDefined();
    expect(saveButton!.hasAttribute("disabled")).toBe(true);
    expect(root!.textContent).toContain("identity.name_taken");
  });

  it("applies an edit with the revision it previewed", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.applyCustomTypeChange.mockResolvedValue({
      identity: { schema: "app", name: "status", kind: "enum" },
      statements: ["ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';"],
      affectedRows: 0,
    });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit", requestId: 1 });
    await flush();
    // Edit mode keeps the object's name in the header and only swaps the form.
    expect(root!.textContent).toContain("status");
    const saveButton = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.includes("structureEditor.save"));
    expect(saveButton).toBeDefined();
    expect(saveButton!.hasAttribute("disabled")).toBe(false);
    saveButton!.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledTimes(1);
    const [connectionId, database, apply] = mocks.applyCustomTypeChange.mock.calls[0]!;
    expect(connectionId).toBe("pg-1");
    expect(database).toBe("demo");
    expect(apply.expectedPlanRevision).toBe("rev-1");
    expect(apply.change.expectedSnapshotRevision).toBe("snapshot-1");
    expect(apply.change.target).toEqual({ schema: "app", name: "status", kind: "enum" });
  });

  it("asks for confirmation before applying a destructive plan and keeps the dialog usable", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.previewCustomTypeChange.mockResolvedValue(
      preview({
        destructive: true,
        statements: ['ALTER DOMAIN "app"."email" DROP CONSTRAINT "c" RESTRICT;'],
        warnings: [{ code: "domain.drop_constraint", message: "Constraint c is dropped.", severity: "destructive" }],
      }),
    );
    let finishApply!: (value: unknown) => void;
    mocks.applyCustomTypeChange.mockReturnValue(
      new Promise((resolve) => {
        finishApply = resolve;
      }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit", requestId: 1 });
    await flush();

    const saveButton = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.includes("structureEditor.save"))!;
    saveButton.dispatchEvent(new MouseEvent("click"));
    await flush();

    // Nothing may be applied before the user confirms.
    expect(mocks.applyCustomTypeChange).not.toHaveBeenCalled();
    const dialog = root!.querySelector(".danger-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("data-title")).toBe("customType.editor.destructiveTitle");
    // Regression: the dialog must be interactive the moment it opens. The old
    // implementation marked the save pending before opening and merged that into
    // `loading`, and DangerConfirmDialog disables confirm, cancel and closing
    // while loading, so the change could never be approved or abandoned.
    expect(dialog!.getAttribute("data-loading")).toBe("false");
    expect(root!.querySelector<HTMLButtonElement>(".danger-confirm")!.disabled).toBe(false);
    expect(root!.querySelector<HTMLButtonElement>(".danger-cancel")!.disabled).toBe(false);
    // The destructive warnings are shown next to the statements.
    expect(root!.textContent).toContain("Constraint c is dropped.");

    // Cancelling is possible and runs nothing.
    root!.querySelector<HTMLButtonElement>(".danger-cancel")!.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(root!.querySelector(".danger-dialog")).toBeNull();
    expect(mocks.applyCustomTypeChange).not.toHaveBeenCalled();

    // Confirming runs the plan. The dialog is gone rather than left open in a
    // locked loading state, and the panel reports the in-flight save instead.
    saveButton.dispatchEvent(new MouseEvent("click"));
    await flush();
    root!.querySelector<HTMLButtonElement>(".danger-confirm")!.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledTimes(1);
    expect(root!.querySelector(".danger-dialog")).toBeNull();
    const saveDuringFlight = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.includes("structureEditor.save"))!;
    expect(saveDuringFlight.disabled).toBe(true);

    finishApply({
      identity: { schema: "app", name: "status", kind: "enum" },
      statements: [],
      affectedRows: 0,
    });
    await flush();
  });

  it("applies a non-destructive plan without a confirmation", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.applyCustomTypeChange.mockResolvedValue({
      identity: { schema: "app", name: "status", kind: "enum" },
      statements: [],
      affectedRows: 0,
    });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit", requestId: 1 });
    await flush();
    const saveButton = Array.from(root!.querySelectorAll("button")).find((b) => b.textContent?.includes("structureEditor.save"));
    saveButton!.dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(root!.querySelector(".danger-dialog")).toBeNull();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledTimes(1);
  });

  it("offers no edit entry for a multirange", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ kind: "multirange", members: [], properties: { domainConstraints: [] } }));
    mountPanel({ connection, database: "demo", schema: "app", name: "_price_range" });
    await flush();
    expect(iconButton("customType.editor.edit")).toBeUndefined();
    expect(iconButton("customType.editor.delete")).toBeDefined();
  });

  it("offers an edit entry for a base type, which only exposes the generic properties", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ kind: "base", members: [], properties: { domainConstraints: [] } }));
    mountPanel({ connection, database: "demo", schema: "app", name: "amount_t" });
    await flush();
    expect(iconButton("customType.editor.edit")).toBeDefined();
    clickIconButton("customType.editor.edit");
    await flush();
    // The draft must describe a base type, not a fabricated Range.
    await vi.waitFor(() => expect(mocks.previewCustomTypeChange).toHaveBeenCalled());
    const request = mocks.previewCustomTypeChange.mock.calls.at(-1)![2];
    expect(request.draft.definition).toEqual({ kind: "none", typeKind: "base" });
    expect(request.target.kind).toBe("base");
  });

  it("asks before closing the panel with unsaved changes", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    // happy-dom does not implement confirm, so install one the test controls.
    const confirmSpy = vi.fn(() => false);
    const originalConfirm = window.confirm;
    window.confirm = confirmSpy as unknown as typeof window.confirm;
    try {
      const closed = vi.fn();
      root = document.createElement("div");
      document.body.append(root);
      app = createApp(CustomTypeInfoPanel, {
        connection,
        database: "demo",
        schema: "app",
        name: "status",
        initialMode: "edit",
        requestId: 1,
        onClose: closed,
      });
      app.mount(root);
      await flush();

      // Make a real edit through the identity field, so the dirty check has
      // something to protect.
      const nameInput = root.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]');
      expect(nameInput).not.toBeNull();
      nameInput!.value = "order_status";
      nameInput!.dispatchEvent(new Event("input"));
      await flush();

      const closeButton = Array.from(root.querySelectorAll("button")).find((b) => b.getAttribute("title") === "common.close");
      expect(closeButton).toBeDefined();

      // Declining the confirm keeps the panel open.
      closeButton!.dispatchEvent(new MouseEvent("click"));
      await flush();
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(closed).not.toHaveBeenCalled();

      // Accepting it closes the panel.
      confirmSpy.mockReturnValue(true);
      closeButton!.dispatchEvent(new MouseEvent("click"));
      await flush();
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("preserves a dirty draft when refresh is declined and reloads when accepted", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    const originalConfirm = window.confirm;
    const confirmSpy = vi.fn(() => false);
    window.confirm = confirmSpy;
    try {
      mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit", requestId: 1 });
      await flush();
      const nameInput = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
      nameInput.value = "unsaved_status";
      nameInput.dispatchEvent(new Event("input"));
      await flush();
      const reads = mocks.getCustomTypeDetails.mock.calls.length;
      clickIconButton("structureEditor.refresh");
      await flush();
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(reads);
      expect(nameInput.value).toBe("unsaved_status");

      confirmSpy.mockReturnValue(true);
      clickIconButton("structureEditor.refresh");
      await flush();
      expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(reads + 1);
      expect(root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!.value).toBe("status");
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("reports the dirty state so a tab close can confirm first", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    const dirtyEvents: boolean[] = [];
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(CustomTypeInfoPanel, {
      connection,
      database: "demo",
      schema: "app",
      name: "status",
      initialMode: "edit",
      requestId: 1,
      onDirtyChange: (dirty: boolean) => dirtyEvents.push(dirty),
    });
    app.mount(root);
    await flush();

    // A pristine edit form is not dirty, so closing the tab prompts nothing.
    expect(dirtyEvents.at(-1)).toBe(false);

    const nameInput = root.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]');
    nameInput!.value = "order_status";
    nameInput!.dispatchEvent(new Event("input"));
    await flush();
    expect(dirtyEvents.at(-1)).toBe(true);

    // Undoing the edit clears it again.
    nameInput!.value = "status";
    nameInput!.dispatchEvent(new Event("input"));
    await flush();
    expect(dirtyEvents.at(-1)).toBe(false);

    // Unmounting must publish a clean state: a stale `true` would block the next
    // open of this tab forever.
    app.unmount();
    app = undefined;
    root!.remove();
    root = undefined;
    expect(dirtyEvents.at(-1)).toBe(false);
  });

  it("opens the delete confirmation with the dependency list in delete mode", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.previewCustomTypeDrop.mockResolvedValue(dropPreview({ dependencies: [{ kind: "column", name: "state", description: "column state of app.orders" }] }));
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "delete", requestId: 1 });
    await flush();
    await vi.waitFor(() => expect(mocks.previewCustomTypeDrop).toHaveBeenCalled());
    expect(mocks.previewCustomTypeDrop.mock.calls[0]![2]).toEqual({
      target: { schema: "app", name: "status", kind: "enum" },
      cascade: false,
    });
    const dialog = root!.querySelector(".danger-dialog");
    expect(dialog).not.toBeNull();
    expect(root!.textContent).toContain("column state of app.orders");
  });
});

describe("CustomTypeInfoPanel editor session regressions", () => {
  it.each(["success", "failure"])("locks the full draft during save and handles %s without losing edits", async (outcome) => {
    mocks.getCustomTypeDetails.mockImplementation(async (_c, _db, _s, name) => enumDetails({ name }));
    let finish!: (value: unknown) => void;
    let fail!: (reason: Error) => void;
    mocks.applyCustomTypeChange.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const sessionChange = vi.fn();
    const close = vi.fn();
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit", onSessionChange: sessionChange, onClose: close });
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "before_save";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flush();
    clickButton("structureEditor.save");
    await flush();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledOnce();
    const submitted = mocks.applyCustomTypeChange.mock.calls[0]![2].change;
    expect(submitted.draft.name).toBe("before_save");
    expect(input.disabled).toBe(true);
    expect(root!.querySelector("fieldset")!.disabled).toBe(true);
    // Synthetic model updates must be rejected as well as ordinary interaction.
    input.value = "after_save";
    input.dispatchEvent(new Event("input"));
    const enumInput = root!.querySelector<HTMLInputElement>('[aria-label="enum value 1"]')!;
    enumInput.value = "changed_during_save";
    enumInput.dispatchEvent(new Event("input"));
    clickIconButton("common.close");
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(sessionChange.mock.calls.at(-1)![0].draft).toEqual(submitted.draft);
    expect(submitted.draft.definition.values[0].value).toBe("draft");
    if (outcome === "success") {
      finish({ identity: { schema: "app", name: "before_save", kind: "enum" } });
      await flush();
      expect(root!.querySelector('[aria-label="customType.editor.namePlaceholder"]')).toBeNull();
      expect(mocks.getCustomTypeDetails).toHaveBeenLastCalledWith("pg-1", "demo", "app", "before_save");
    } else {
      fail(new Error("save rejected"));
      await flush();
      expect(input.disabled).toBe(false);
      expect(root!.querySelector("fieldset")!.disabled).toBe(false);
      expect(sessionChange.mock.calls.at(-1)![0].draft.name).toBe("before_save");
      expect(sessionChange.mock.calls.at(-1)![0].details.snapshotRevision).toBe("snapshot-1");
    }
  });

  it.each(["success", "failure"])("ignores a stale CASCADE %s while the newer RESTRICT preview is pending", async (outcome) => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.previewCustomTypeDrop.mockResolvedValue(dropPreview());
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    clickIconButton("customType.editor.delete");
    await flush();
    let finishCascade!: (value: CustomTypeDropPreview) => void;
    let failCascade!: (reason: Error) => void;
    let finishRestrict!: (value: CustomTypeDropPreview) => void;
    mocks.previewCustomTypeDrop.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishCascade = resolve;
          failCascade = reject;
        }),
    );
    const cascade = root!.querySelector<HTMLInputElement>('.danger-dialog input[type="checkbox"]')!;
    cascade.dispatchEvent(new Event("change"));
    await flush();
    mocks.previewCustomTypeDrop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestrict = resolve;
        }),
    );
    cascade.dispatchEvent(new Event("change"));
    await flush();
    if (outcome === "success") finishCascade(dropPreview({ statement: "stale CASCADE SQL", planRevision: "stale-cascade" }));
    else failCascade(new Error("stale cascade error"));
    await flush();
    expect(root!.querySelector<HTMLButtonElement>(".danger-confirm")!.disabled).toBe(true);
    expect(root!.querySelector(".danger-dialog")!.getAttribute("data-sql")).toBe("");
    expect(root!.textContent).not.toContain("stale cascade error");
    expect(root!.textContent).toContain("common.loading");
    finishRestrict(dropPreview({ planRevision: "latest-restrict" }));
    await flush();
    expect(root!.querySelector(".danger-dialog")!.getAttribute("data-sql")).toContain("RESTRICT");
    expect(root!.querySelector<HTMLButtonElement>(".danger-confirm")!.disabled).toBe(false);
    mocks.applyCustomTypeDrop.mockResolvedValue({ identity: { schema: "app", name: "status", kind: "enum" } });
    root!.querySelector<HTMLButtonElement>(".danger-confirm")!.click();
    await flush();
    expect(mocks.applyCustomTypeDrop).toHaveBeenCalledWith("pg-1", "demo", {
      request: { target: { schema: "app", name: "status", kind: "enum" }, cascade: false },
      expectedPlanRevision: "latest-restrict",
    });
  });

  it("disables deletion when preview fails and ignores an earlier response after reopening", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    let finish!: (value: CustomTypeDropPreview) => void;
    mocks.previewCustomTypeDrop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mountPanel({ connection, database: "demo", schema: "app", name: "status" });
    await flush();
    clickIconButton("customType.editor.delete");
    await flush();
    root!.querySelector<HTMLButtonElement>(".danger-cancel")!.click();
    await flush();
    mocks.previewCustomTypeDrop.mockRejectedValueOnce(new Error("current preview failed"));
    clickIconButton("customType.editor.delete");
    await flush();
    finish(dropPreview({ statement: "stale SQL" }));
    await flush();
    expect(root!.textContent).toContain("current preview failed");
    expect(root!.querySelector(".danger-dialog")!.getAttribute("data-sql")).toBe("");
    expect(root!.querySelector<HTMLButtonElement>(".danger-confirm")!.disabled).toBe(true);
    root!.querySelector<HTMLButtonElement>(".danger-confirm")!.click();
    expect(mocks.applyCustomTypeDrop).not.toHaveBeenCalled();
  });

  it("refreshes the saved identity after rename without returning to edit mode", async () => {
    mocks.getCustomTypeDetails.mockImplementation(async (_c, _db, _s, name) => enumDetails({ name }));
    mocks.applyCustomTypeChange.mockResolvedValue({ identity: { schema: "app", name: "renamed", kind: "enum" } });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit" });
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "renamed";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flush();
    clickButton("structureEditor.save");
    await flush();
    clickIconButton("structureEditor.refresh");
    await flush();
    expect(mocks.getCustomTypeDetails).toHaveBeenLastCalledWith("pg-1", "demo", "app", "renamed");
    expect(root!.querySelector('[aria-label="customType.editor.namePlaceholder"]')).toBeNull();
  });

  it("refreshes a newly saved type rather than starting another create draft", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mocks.applyCustomTypeChange.mockResolvedValue({ identity: { schema: "app", name: "status", kind: "enum" } });
    mountPanel({ connection, database: "demo", schema: "app", name: "", initialMode: "create" });
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "status";
    input.dispatchEvent(new Event("input"));
    await flush();
    const enumInput = root!.querySelector<HTMLInputElement>('[aria-label="enum value 1"]')!;
    enumInput.value = "draft";
    enumInput.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flush();
    clickButton("structureEditor.save");
    await flush();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledOnce();
    clickIconButton("structureEditor.refresh");
    await flush();
    expect(mocks.getCustomTypeDetails).toHaveBeenLastCalledWith("pg-1", "demo", "app", "status");
    expect(root!.querySelector('[aria-label="customType.editor.namePlaceholder"]')).toBeNull();
  });

  it("restores the draft and its original snapshot after KeepAlive evicts the tab", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    const active = ref(0);
    const session = ref<CustomTypeEditorSession | null>(null);
    const dirty = vi.fn();
    const Dummy = defineComponent({ render: () => h("div", "other tab") });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp({
      setup: () => () =>
        h(
          RetainedKeepAlive,
          { max: 3, cacheKey: String(active.value) },
          {
            default: () =>
              active.value === 0
                ? h(CustomTypeInfoPanel, {
                    key: "type",
                    connection,
                    database: "demo",
                    schema: "app",
                    name: "status",
                    initialMode: "edit",
                    session: session.value,
                    onSessionChange: (value: CustomTypeEditorSession) => {
                      session.value = value;
                    },
                    onDirtyChange: dirty,
                  })
                : h(Dummy, { key: `other:${active.value}` }),
          },
        ),
    });
    app.mount(root);
    await flush();
    const input = root.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "unsaved_name";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(dirty).toHaveBeenLastCalledWith(true);
    for (const id of [1, 2, 3]) {
      active.value = id;
      await flush();
    }
    expect(dirty).toHaveBeenLastCalledWith(true);
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ snapshotRevision: "snapshot-2" }));
    active.value = 0;
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!.value).toBe("unsaved_name");
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledOnce();
    expect(mocks.previewCustomTypeChange.mock.calls.at(-1)![2].expectedSnapshotRevision).toBe("snapshot-1");
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it.each([true, false])("finishes a renamed type save across cache pressure (return while pending: %s)", async (returnWhilePending) => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    let finish!: (value: { identity: { schema: string; name: string; kind: string } }) => void;
    mocks.applyCustomTypeChange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { active, session, dirty, saved } = mountCachedPanel();
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "renamed";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(mocks.previewCustomTypeChange.mock.calls.at(-1)?.[2].draft.name).toBe("renamed"));
    await flush();
    expect(clickButton("structureEditor.save")!.disabled).toBe(false);
    await flush();
    for (const id of [1, 2, 3]) {
      active.value = id;
      await flush();
    }
    if (returnWhilePending) {
      active.value = 0;
      await flush();
      expect(root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!.disabled).toBe(true);
      expect(clickButton("structureEditor.save")!.disabled).toBe(true);
      expect(mocks.applyCustomTypeChange).toHaveBeenCalledOnce();
      expect(mocks.getCustomTypeDetails).toHaveBeenCalledOnce();
    }
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ name: "renamed", snapshotRevision: "snapshot-2" }));
    finish({ identity: { schema: "app", name: "renamed", kind: "enum" } });
    await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(session.value).toMatchObject({ name: "renamed", mode: "view", draft: null, originalDraft: null });
    expect(dirty).toHaveBeenLastCalledWith(false);
    const readsAfterSave = mocks.getCustomTypeDetails.mock.calls.length;
    // Once the mutation has finished, normal eviction and clean restoration resume.
    for (const id of [4, 5, 6]) {
      active.value = id;
      await flush();
    }
    active.value = 0;
    await flush();
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledTimes(readsAfterSave + 1);
    expect(mocks.getCustomTypeDetails).toHaveBeenLastCalledWith("pg-1", "demo", "app", "renamed");
    expect(root!.querySelector('[aria-label="customType.editor.namePlaceholder"]')).toBeNull();
  });

  it.each([true, false])("keeps the draft and save error across cache pressure (return while pending: %s)", async (returnWhilePending) => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    let fail!: (error: Error) => void;
    mocks.applyCustomTypeChange.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { active, session, dirty, saved } = mountCachedPanel();
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "renamed";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(mocks.previewCustomTypeChange.mock.calls.at(-1)?.[2].draft.name).toBe("renamed"));
    await flush();
    clickButton("structureEditor.save");
    await flush();
    for (const id of [1, 2, 3]) {
      active.value = id;
      await flush();
    }
    if (returnWhilePending) {
      active.value = 0;
      await flush();
    }
    fail(new Error("rename rejected"));
    await flush();
    active.value = 0;
    await flush();
    expect(root!.textContent).toContain("rename rejected");
    expect(root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!.value).toBe("renamed");
    expect(session.value).toMatchObject({ mode: "edit", name: "status", draft: { name: "renamed" }, details: { snapshotRevision: "snapshot-1" } });
    expect(dirty).toHaveBeenLastCalledWith(true);
    expect(saved).not.toHaveBeenCalled();
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledOnce();
  });

  it("delivers deletion to the owning surface after switching through the cache", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    let finish!: (value: { identity: { schema: string; name: string; kind: string } }) => void;
    mocks.applyCustomTypeDrop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { active, deleted, session } = mountCachedPanel("delete");
    await flush(12);
    root!.querySelector<HTMLButtonElement>(".danger-confirm")!.click();
    await flush();
    expect(mocks.applyCustomTypeDrop).toHaveBeenCalledOnce();
    for (const id of [1, 2, 3]) {
      active.value = id;
      await flush();
    }
    finish({ identity: { schema: "app", name: "status", kind: "enum" } });
    await flush();
    expect(deleted).toHaveBeenCalledOnce();
    expect(session.value).toBeNull();
    active.value = 0;
    await flush();
    expect(root!.textContent).toContain("type deleted");
  });

  it.each([false, true])("saves an empty composite (remove final attribute: %s)", async (removeFinalAttribute) => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails({ kind: "composite", members: removeFinalAttribute ? [{ name: "value", dataType: "text", ordinal: 1 }] : [] }));
    mocks.previewCustomTypeChange.mockResolvedValue(
      preview({
        statements: [removeFinalAttribute ? 'ALTER TYPE "app"."status" DROP ATTRIBUTE "value"' : 'COMMENT ON TYPE "app"."status" IS \'empty record\''],
        destructive: removeFinalAttribute,
        resultingIdentity: { schema: "app", name: "status", kind: "composite" },
      }),
    );
    mocks.applyCustomTypeChange.mockResolvedValue({ identity: { schema: "app", name: "status", kind: "composite" } });
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit" });
    await flush();
    if (removeFinalAttribute) {
      clickIconButton("customType.editor.dropAttributeHint");
    } else {
      const comment = root!.querySelector<HTMLInputElement>('[aria-label="customType.members.comment"]')!;
      comment.value = "empty record";
      comment.dispatchEvent(new Event("input"));
    }
    await flush();
    await vi.waitFor(() =>
      expect(mocks.previewCustomTypeChange.mock.calls.at(-1)?.[2].draft).toMatchObject({
        definition: { kind: "composite", attributes: [] },
        ...(!removeFinalAttribute ? { comment: "empty record" } : {}),
      }),
    );
    await flush();
    expect(clickButton("structureEditor.save")!.disabled).toBe(false);
    await flush();
    if (removeFinalAttribute) root!.querySelector<HTMLButtonElement>(".danger-confirm")!.click();
    await flush();
    expect(mocks.applyCustomTypeChange).toHaveBeenCalledOnce();
    expect(mocks.applyCustomTypeChange.mock.calls[0]![2].change.draft.definition).toEqual({ kind: "composite", attributes: [] });
  });

  it("disables save immediately during debounce and ignores earlier preview responses", async () => {
    mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
    mountPanel({ connection, database: "demo", schema: "app", name: "status", initialMode: "edit" });
    await flush();
    const input = root!.querySelector<HTMLInputElement>('[aria-label="customType.editor.namePlaceholder"]')!;
    input.value = "first_name";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(clickButton("structureEditor.save")!.disabled).toBe(true);
    expect(mocks.applyCustomTypeChange).not.toHaveBeenCalled();
    let finish!: (value: CustomTypeChangePreview) => void;
    mocks.previewCustomTypeChange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 280));
    input.value = "second_name";
    input.dispatchEvent(new Event("input"));
    finish(preview({ planRevision: "obsolete" }));
    await flush();
    expect(clickButton("structureEditor.save")!.disabled).toBe(true);
    expect(mocks.applyCustomTypeChange).not.toHaveBeenCalled();
    mocks.previewCustomTypeChange.mockResolvedValue(preview({ planRevision: "latest" }));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flush();
    expect(clickButton("structureEditor.save")!.disabled).toBe(false);
  });
});
