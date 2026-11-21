// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import OracleViewRenamePreview from "../OracleViewRenamePreview.vue";
import type { OracleViewRenamePlan } from "@/lib/table/oracleViewRename";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), rewriteOracleViewRenameSource: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);

function fixture(): OracleViewRenamePlan {
  return {
    target: { connectionId: "preview-c", database: "OWNER", schema: "OWNER", oldName: "ROOT", newName: "NEW_ROOT" },
    canonicalNewName: "NEW_ROOT",
    coverage: "visible-only",
    metadataComplete: true,
    executable: false,
    issues: [{ code: "unsupported_hint", message: "Unsupported backend hint syntax", viewName: "BROKEN", hintText: "FULL(旧对象@QB)", location: { line: 3, column: 8 }, repairable: true }],
    views: [
      {
        name: "ROOT",
        source: "CREATE VIEW ROOT AS SELECT 1 FROM DUAL",
        grants: "[]",
        draft: "CREATE VIEW ROOT AS SELECT 1 FROM DUAL",
        references: [{ owner: "OWNER", name: "DUAL" }],
        fingerprint: "root",
        rewrittenSource: "CREATE VIEW NEW_ROOT AS SELECT 1 FROM DUAL",
        rewrittenFingerprint: "new-root",
      },
      { name: "BROKEN", source: "CREATE VIEW BROKEN AS SELECT /*+ FULL(旧对象@QB) */ * FROM ROOT", grants: "[]", draft: "CREATE VIEW BROKEN AS SELECT /*+ FULL(旧对象@QB) */ * FROM ROOT", references: [{ owner: "OWNER", name: "ROOT" }], fingerprint: "", rewrittenSource: "", rewrittenFingerprint: "" },
      {
        name: "SAFE",
        source: "CREATE VIEW SAFE AS SELECT * FROM ROOT",
        grants: "[]",
        draft: "CREATE VIEW SAFE AS SELECT * FROM ROOT",
        references: [{ owner: "OWNER", name: "ROOT" }],
        fingerprint: "safe",
        rewrittenSource: "CREATE VIEW SAFE AS SELECT * FROM NEW_ROOT",
        rewrittenFingerprint: "new-safe",
      },
    ],
    dependencyEdges: [],
    statements: ["RENAME ROOT TO NEW_ROOT", "CREATE VIEW SAFE AS SELECT * FROM NEW_ROOT"],
    steps: [],
  };
}

const cleanups: Array<() => void> = [];
function mount(options: Partial<{ plan: OracleViewRenamePlan | null; drafts: Record<string, string>; loading: boolean; validating: boolean; executing: boolean }> = {}) {
  const state = reactive({ plan: fixture() as OracleViewRenamePlan | null, drafts: {} as Record<string, string>, loading: false, validating: false, executing: false, ...options });
  const edit = vi.fn();
  const validate = vi.fn();
  const reload = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({ render: () => h(OracleViewRenamePreview, { ...state, onEdit: edit, onValidate: validate, onReload: reload }) }).use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { container, state, edit, validate, reload };
}

describe("Oracle view rename repair preview", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  it("shows the affected object, hint and location while preserving other generated SQL", async () => {
    const { container, edit } = mount({ drafts: { BROKEN: "my edited definition" } });
    const broken = container.querySelector<HTMLDetailsElement>('[data-view-name="BROKEN"]')!;
    const safe = container.querySelector<HTMLDetailsElement>('[data-view-name="SAFE"]')!;
    expect(broken.open).toBe(true);
    expect(safe.open).toBe(false);
    expect(broken.textContent).toContain("FULL(旧对象@QB)");
    expect(i18n.global.t("objects.viewRenameIssueHint")).toContain("已自动改写可确认的引用");
    expect(i18n.global.t("objects.viewRenameIssueHint")).toContain("按上方位置");
    expect(i18n.global.t("objects.viewRenameIssueHint")).toContain("重新校验");
    expect(broken.textContent).toContain(i18n.global.t("objects.viewRenameIssueHint"));
    expect(i18n.global.t("objects.viewRenameIssueHint")).toMatch(/[\u4e00-\u9fff]/);
    expect(broken.textContent).toContain(i18n.global.t("objects.viewRenameIssueLocation", { line: 3, column: 8 }));
    const diagnostics = broken.querySelector<HTMLDetailsElement>("[data-diagnostics]")!;
    expect(diagnostics.open).toBe(false);
    expect(diagnostics.textContent).toContain("Unsupported backend hint syntax");
    expect(broken.querySelector("summary")!.textContent).not.toContain("Unsupported backend");
    expect(safe.textContent).toContain("CREATE VIEW SAFE AS SELECT * FROM NEW_ROOT");
    const draft = broken.querySelector("textarea")!;
    expect(draft.value).toBe("my edited definition");
    expect(draft.closest("label")!.textContent).toContain("OWNER.BROKEN");
    expect(draft.closest("label")!.textContent).toContain(i18n.global.t("objects.viewRenameDraft"));
    draft.value = "CREATE VIEW BROKEN AS SELECT * FROM ROOT";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(edit).toHaveBeenCalledWith("BROKEN", draft.value);
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.rewriteOracleViewRenameSource).not.toHaveBeenCalled();
  });

  it("hides generated SQL for an edited draft until that draft is revalidated", () => {
    const { container } = mount({ drafts: { SAFE: "CREATE VIEW SAFE AS SELECT * FROM OTHER" } });
    const safe = container.querySelector<HTMLDetailsElement>('[data-view-name="SAFE"]')!;
    expect(safe.textContent).not.toContain("CREATE VIEW SAFE AS SELECT * FROM NEW_ROOT");
    expect(container.textContent).not.toContain("RENAME ROOT TO NEW_ROOT");
  });

  it("emits validation and reload actions, and disables editing and actions during execution", async () => {
    const { container, state, validate, reload } = mount();
    container.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    container.querySelector<HTMLButtonElement>("[data-reload]")!.click();
    expect(validate).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    state.executing = true;
    await nextTick();
    expect([...container.querySelectorAll("textarea")].every((input) => input.disabled)).toBe(true);
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    container.querySelector<HTMLButtonElement>("[data-validate]")!.click();
    expect(validate).toHaveBeenCalledOnce();
  });

  it("keeps all objects and safe SQL visible when metadata cannot be repaired by editing", () => {
    const plan = fixture();
    plan.metadataComplete = false;
    plan.issues.push({ code: "dependency_scope", message: "Foreign owner dependency", viewName: "FOREIGN.V", repairable: false });
    plan.views[1]!.source = "";
    const { container } = mount({ plan });
    expect(container.querySelectorAll("[data-view-name]")).toHaveLength(4);
    expect(container.textContent).toContain("FOREIGN.V");
    expect(container.textContent).toContain(i18n.global.t("objects.viewRenameMetadataProblem"));
    expect(container.textContent).toContain("CREATE VIEW SAFE AS SELECT * FROM NEW_ROOT");
    expect(container.querySelector<HTMLTextAreaElement>('[data-view-name="BROKEN"] textarea')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("[data-reload]")!.disabled).toBe(false);
  });

  it("offers a localized loading state and reload when no plan is available", async () => {
    const { container, state, reload } = mount({ plan: null, loading: true });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(i18n.global.t("common.loading"));
    state.loading = false;
    await nextTick();
    expect(container.querySelector<HTMLButtonElement>("[data-validate]")!.disabled).toBe(true);
    container.querySelector<HTMLButtonElement>("[data-reload]")!.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
