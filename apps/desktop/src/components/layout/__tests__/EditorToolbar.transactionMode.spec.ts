import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../EditorToolbar.vue", import.meta.url), "utf8");

describe("EditorToolbar transaction mode control", () => {
  it("shows an A or M badge next to Tx instead of relying on color alone", () => {
    expect(toolbarSource).toContain('const transactionModeBadge = computed(() => (isManualTransactionMode.value ? "M" : "A"));');
    expect(toolbarSource).toContain('<span class="text-[11px] font-bold">Tx:</span>');
    expect(toolbarSource).toContain(">{{ transactionModeBadge }}</span>");
  });

  it("exposes the transaction mode to assistive technology", () => {
    expect(toolbarSource).toContain('class="ml-1 flex items-center gap-0.5 border-l border-border/60 pl-1" role="group" :aria-label="transactionTooltip"');
    expect(toolbarSource).toContain(':aria-label="transactionTooltip"');
    expect(toolbarSource).toContain(':aria-pressed="isManualTransactionMode"');
    expect(toolbarSource).toContain(":aria-label=\"t('toolbar.commit')\"");
    expect(toolbarSource).toContain(":aria-label=\"t('toolbar.rollback')\"");
  });

  it("places the transaction controls at the end in mode, commit, rollback order", () => {
    const multiExecuteIndex = toolbarSource.indexOf("@click=\"emit('multiExecute')\"");
    const transactionToggleIndex = toolbarSource.indexOf("@click=\"emit('update:autoCommit', autoCommit === false)\"");
    const commitIndex = toolbarSource.indexOf("@click=\"emit('commit')\"");
    const rollbackIndex = toolbarSource.indexOf("@click=\"emit('rollback')\"");
    const actionGroupEndIndex = toolbarSource.indexOf('<span class="flex-1 min-w-0" />');

    expect(multiExecuteIndex).toBeGreaterThan(-1);
    expect(transactionToggleIndex).toBeGreaterThan(multiExecuteIndex);
    expect(commitIndex).toBeGreaterThan(transactionToggleIndex);
    expect(rollbackIndex).toBeGreaterThan(commitIndex);
    expect(actionGroupEndIndex).toBeGreaterThan(rollbackIndex);
  });

  it("hides Commit/Rollback for a clean Oracle manual session only", () => {
    expect(toolbarSource).toContain("const showTxnActions = computed(() => {");
    expect(toolbarSource).toContain("if (props.isOracleManualTransaction) return isTransactionActive.value && props.oracleTxnPossiblyDirty === true;");
    expect(toolbarSource).toContain("return isTransactionActive.value;");
    // Both buttons are driven by the combined condition.
    expect(toolbarSource).toContain('<Tooltip v-if="showTxnActions">');
    expect(toolbarSource.match(/<Tooltip v-if="showTxnActions">/g)).toHaveLength(2);
  });
});
