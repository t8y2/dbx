// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import MultiSourceMergeView from "@/components/editor/MultiSourceMergeView.vue";
import type { QueryResult } from "@/types/database";

function writeResult(affectedRows: number): QueryResult {
  return { columns: [], rows: [], affected_rows: affectedRows, execution_time_ms: 7 };
}

/** One batch that ran inside per-target transactions. */
function items() {
  return [
    { key: "a", label: "conn-a", status: "pending_commit" as const, durationMs: 12, result: writeResult(3), transaction: { canCommit: true } },
    // A target whose session survived a rollback failure: it can still be rolled back.
    { key: "b", label: "conn-b", status: "failed" as const, durationMs: 9, errorMessage: "syntax error", transaction: { canCommit: false } },
    { key: "c", label: "conn-c", status: "success" as const, durationMs: 5, result: writeResult(0) },
    { key: "d", label: "conn-d", status: "rolled_back" as const, durationMs: 4 },
  ];
}

function mountView(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(MultiSourceMergeView, props) });
  app.use(i18n);
  app.mount(host);
  return { host, app };
}

let mounted: ReturnType<typeof mountView> | undefined;

afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
});

describe("MultiSourceMergeView transactions", () => {
  it("shows the transaction state per target and offers commit/rollback only while open", async () => {
    mounted = mountView({ items: items(), transactional: true });
    await nextTick();

    const states = [...mounted.host.querySelectorAll("[data-merge-txn-state]")].map((cell) => cell.textContent?.trim());
    expect(states).toEqual([i18n.global.t("multiDbExecute.txnOpen"), i18n.global.t("multiDbExecute.txnOpen"), i18n.global.t("multiDbExecute.txnCommitted"), i18n.global.t("multiDbExecute.txnRolledBack")]);

    // Two open sessions: each offers one commit and one rollback button.
    expect(mounted.host.querySelectorAll("[data-merge-commit]")).toHaveLength(2);
    expect(mounted.host.querySelectorAll("[data-merge-rollback]")).toHaveLength(2);
  });

  it("blocks committing a target that errored and counts only committable targets", async () => {
    mounted = mountView({ items: items(), transactional: true });
    await nextTick();

    const commitButtons = [...mounted.host.querySelectorAll("[data-merge-commit]")] as HTMLButtonElement[];
    expect(commitButtons[0]?.disabled).toBe(false);
    // conn-b failed, so its transaction has nothing to write but can be discarded.
    expect(commitButtons[1]?.disabled).toBe(true);

    const commitAll = mounted.host.querySelector("[data-merge-commit-all]") as HTMLButtonElement;
    expect(commitAll.textContent).toContain("1");
  });

  it("blocks every transaction control while one of them is settling", async () => {
    const settling = items();
    settling[0] = { ...settling[0]!, transaction: { canCommit: true, settling: true } } as (typeof settling)[number];
    mounted = mountView({ items: settling, transactional: true });
    await nextTick();

    const commitButtons = [...mounted.host.querySelectorAll("[data-merge-commit]")] as HTMLButtonElement[];
    const rollbackButtons = [...mounted.host.querySelectorAll("[data-merge-rollback]")] as HTMLButtonElement[];
    expect(commitButtons[0]?.disabled).toBe(true);
    expect(rollbackButtons[0]?.disabled).toBe(true);
  });

  it("emits per-target and batch transaction actions", async () => {
    const events: string[] = [];
    mounted = mountView({
      items: items(),
      transactional: true,
      onCommitTarget: (key: string) => events.push(`commit:${key}`),
      onRollbackTarget: (key: string) => events.push(`rollback:${key}`),
      onCommitAll: () => events.push("commit-all"),
      onRollbackAll: () => events.push("rollback-all"),
    });
    await nextTick();

    (mounted.host.querySelectorAll("[data-merge-commit]")[0] as HTMLButtonElement).click();
    (mounted.host.querySelectorAll("[data-merge-rollback]")[1] as HTMLButtonElement).click();
    (mounted.host.querySelector("[data-merge-commit-all]") as HTMLButtonElement).click();
    (mounted.host.querySelector("[data-merge-rollback-all]") as HTMLButtonElement).click();
    await nextTick();

    expect(events).toEqual(["commit:a", "rollback:b", "commit-all", "rollback-all"]);
  });

  it("hides every transaction control for an auto-commit batch", async () => {
    const autoCommit = items().map(({ transaction: _transaction, ...item }) => ({ ...item, status: item.status === "pending_commit" ? ("success" as const) : item.status }));
    mounted = mountView({ items: autoCommit, transactional: false });
    await nextTick();

    expect(mounted.host.querySelector("[data-merge-txn-state]")).toBeNull();
    expect(mounted.host.querySelector("[data-merge-commit-all]")).toBeNull();
    expect(mounted.host.querySelector("[data-merge-rollback-all]")).toBeNull();
    // A failed target without a session keeps its re-run affordance instead.
    expect(mounted.host.querySelector("[data-merge-rerun]")).not.toBeNull();
  });
});
