// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createApp, defineComponent, h, inject, nextTick, provide, reactive, toRef, type App, type Ref, watch } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
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

historyMocks.load.mockReturnValue([]);

vi.mock("@/composables/useSqlHighlighter", () => ({
  useSqlHighlighter: () => ({ highlight: (sql: string) => sql }),
}));

const dialogHarness = vi.hoisted(() => {
  const pendingCloseAutoFocus: Array<() => Event> = [];
  return {
    pendingCloseAutoFocus,
    flushCloseAutoFocus: () => pendingCloseAutoFocus.shift()?.(),
    reset: () => pendingCloseAutoFocus.splice(0),
  };
});

vi.mock("@/components/ui/dialog", () => {
  const dialogContextKey = Symbol("sql-parameter-dialog-focus-test");
  type DialogContext = { open: Readonly<Ref<boolean>>; trigger: Element | null };

  const passthrough = () =>
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    });

  const Dialog = defineComponent({
    props: { open: { type: Boolean, default: false } },
    setup(props, { slots }) {
      provide<DialogContext>(dialogContextKey, {
        open: toRef(props, "open"),
        trigger: document.activeElement,
      });
      return () => h("div", slots.default?.());
    },
  });

  const DialogContent = defineComponent({
    emits: ["openAutoFocus", "closeAutoFocus"],
    setup(_, { emit, slots }) {
      const context = inject<DialogContext>(dialogContextKey);
      if (!context) throw new Error("DialogContent must be nested in Dialog");

      watch(context.open, (isOpen, wasOpen) => {
        if (isOpen || !wasOpen) return;
        dialogHarness.pendingCloseAutoFocus.push(() => {
          const event = new Event("close-auto-focus", { cancelable: true });
          emit("closeAutoFocus", event);
          if (!event.defaultPrevented && context.trigger instanceof HTMLElement && context.trigger.isConnected) {
            context.trigger.focus();
            context.trigger.dispatchEvent(new Event("test-native-focus-restoration"));
          }
          return event;
        });
      });

      return () => h("div", slots.default?.());
    },
  });

  return {
    Dialog,
    DialogContent,
    DialogFooter: passthrough(),
    DialogHeader: passthrough(),
    DialogTitle: passthrough(),
  };
});

const SQL = "SELECT ${value}";
const PARAMETERS: SqlParameterDescriptor[] = [{ key: "value", name: "value", syntax: "shell", token: "${value}" }];

const mountedApps: App[] = [];
const editorViews: EditorView[] = [];

afterEach(() => {
  dialogHarness.reset();
  for (const app of mountedApps.splice(0)) app.unmount();
  for (const view of editorViews.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

function mountDialog(state: { open: boolean }) {
  const dialogHost = document.createElement("div");
  document.body.append(dialogHost);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SqlParameterDialog, {
          open: state.open,
          sql: SQL,
          parameters: PARAMETERS,
          databaseType: "mysql",
          enabledSyntaxes: ["shell"],
          "onUpdate:open": (open: boolean) => {
            state.open = open;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(dialogHost);
  return dialogHost;
}

function createEditor() {
  const editorHost = document.createElement("div");
  document.body.append(editorHost);
  const view = new EditorView({
    state: EditorState.create({
      doc: "SELECT :value;\nSELECT 2;\nSELECT 3;",
      selection: { anchor: 20 },
    }),
    parent: editorHost,
  });
  editorViews.push(view);
  view.focus();
  view.contentDOM.addEventListener("test-native-focus-restoration", () => {
    view.dispatch({ selection: { anchor: 0 } });
  });
  return view;
}

describe("SqlParameterDialog focus restoration", () => {
  it("prevents native restoration and keeps the CodeMirror selection after cancel", async () => {
    const view = createEditor();
    const state = reactive({ open: true });
    mountDialog(state);
    await nextTick();

    state.open = false;
    await nextTick();

    const closeAutoFocus = dialogHarness.flushCloseAutoFocus();
    expect(closeAutoFocus?.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    expect(view.state.selection.main.head).toBe(20);
  });

  it("leaves default restoration available for non-CodeMirror triggers", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const state = reactive({ open: true });
    mountDialog(state);
    await nextTick();
    state.open = false;
    await nextTick();

    const closeAutoFocus = dialogHarness.flushCloseAutoFocus();
    expect(closeAutoFocus?.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
