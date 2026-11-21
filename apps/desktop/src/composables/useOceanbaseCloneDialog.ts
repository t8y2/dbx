import { computed, onScopeDispose, shallowRef } from "vue";
import type { DuplicateTableStructurePlan } from "@/lib/database/dbAdminSql";
import { OceanbaseCloneValidationError, OceanbaseTableCloneError, type OceanbaseTableClone } from "@/lib/database/oceanbaseTableClone";

export interface OceanbaseCloneDialogPlan {
  plan: DuplicateTableStructurePlan;
  /** Captured connection, database and catalog identity, never current UI selection. */
  scope: string[];
}

type Translate = (key: string, values?: Record<string, string | number>) => string;
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;
const target = (clone: OceanbaseTableClone) => `${quoted(clone.targetSchema)}.${quoted(clone.targetName)}`;

/** Confirmation and result state for the two existing OceanBase clone surfaces. */
export function useOceanbaseCloneDialog(t: Translate) {
  const state = shallowRef<{ failure: boolean; summary: string; details: string } | null>(null);
  let resolvePending: ((confirmed: boolean) => void) | undefined;
  let disposed = false;
  let running = false;
  const text = (key: string, values?: Record<string, string | number>) => t(`oceanbaseCloneDialog.${key}`, values);
  const open = computed({
    get: () => state.value !== null,
    set: (value: boolean) => {
      if (!value) settle(false);
    },
  });

  function settle(confirmed: boolean) {
    const resolve = resolvePending;
    resolvePending = undefined;
    state.value = null;
    resolve?.(confirmed);
  }

  async function run(action: () => Promise<void>) {
    if (disposed || running || state.value) return;
    running = true;
    try {
      await action();
    } finally {
      running = false;
    }
  }

  function request(plans: OceanbaseCloneDialogPlan[]): Promise<boolean> {
    if (disposed || state.value) return Promise.resolve(false);
    const clones = plans.filter((item) => item.plan.oceanbaseClone);
    if (!clones.length) return Promise.resolve(true);
    const tables = new Set<string>();
    const indexes = new Set<string>();
    for (const item of clones) {
      const clone = item.plan.oceanbaseClone!;
      const scope = [...item.scope, clone.targetSchema];
      const tableKey = JSON.stringify([...scope, clone.targetName]);
      if (tables.has(tableKey)) throw new Error(text("duplicateTarget", { name: target(clone) }));
      tables.add(tableKey);
      for (const name of clone.indexNames) {
        const indexKey = JSON.stringify([...scope, name]);
        if (indexes.has(indexKey)) throw new Error(text("duplicateIndex", { name: `${quoted(clone.targetSchema)}.${quoted(name)}` }));
        indexes.add(indexKey);
      }
    }
    const summary = clones
      .map(({ plan }) => {
        const clone = plan.oceanbaseClone!;
        const scope = text("scope", { columns: clone.columnCount, keys: clone.steps.filter((step) => step.kind === "primaryKey").length, indexes: clone.indexNames.length, comments: clone.steps.filter((step) => step.kind === "comment").length });
        const excluded = clone.exclusions.map((item) => {
          if (item.kind === "partitioning") return text("partitioning");
          const kind = item.kind === "constraint" ? { "FOREIGN KEY": "foreignKey", UNIQUE: "unique", CHECK: "check" }[item.type || ""] || "constraint" : item.kind;
          return `${text(kind)} ${quoted(item.name || "")}`;
        });
        return `${target(clone)}\n${scope}\n${text("excluded")}: ${excluded.join(", ") || text("none")}`;
      })
      .join("\n\n");
    state.value = { failure: false, summary, details: clones.map(({ plan }) => plan.sql).join("\n\n") };
    return new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
  }

  function showFailure(error: unknown, unexecutedTargets: string[] = [], refreshErrors: unknown[] = [], completedTargets: string[] = []) {
    if (disposed) return;
    settle(false);
    const execution = error instanceof OceanbaseTableCloneError ? error.execution : undefined;
    const original = execution?.cause ?? error;
    const cause = original instanceof OceanbaseCloneValidationError ? text(original.key, original.values) : original instanceof Error ? original.message : String(original);
    const summary = [error instanceof OceanbaseTableCloneError ? `${quoted(error.targetSchema)}.${quoted(error.targetName)}` : "", cause, text("noRollback")].filter(Boolean).join("\n");
    const details =
      execution?.steps.map((step, position) => {
        const status = position < execution.failedPosition ? "completed" : position > execution.failedPosition || execution.notExecuted ? "notExecuted" : execution.rejected ? "rejected" : "unknown";
        return `${text(status)}: ${text(step.kind)} ${step.name}\n${step.sql}`;
      }) || [];
    if (completedTargets.length) details.unshift(`${text("completed")}:\n${completedTargets.join("\n")}`);
    if (unexecutedTargets.length) details.push(`${text("notExecuted")}:\n${unexecutedTargets.join("\n")}`);
    if (refreshErrors.length) details.push(`${text("refreshFailed")}:\n${refreshErrors.map((value) => (value instanceof Error ? value.message : String(value))).join("\n")}`);
    state.value = { failure: true, summary, details: details.join("\n\n") };
  }

  onScopeDispose(() => {
    disposed = true;
    settle(false);
  });
  return { state, open, request, showFailure, run, confirm: () => settle(true) };
}
