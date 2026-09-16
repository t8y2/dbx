import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../EditorToolbar.vue", import.meta.url), "utf8");

describe("EditorToolbar transaction mode actions", () => {
  it("hides Commit/Rollback for a clean sticky proven-read-only session only", () => {
    expect(toolbarSource).toContain("const showTxnActions = computed(() => {");
    expect(toolbarSource).toContain("if (props.stickyProvenReadOnlyState) return isTransactionActive.value && props.txnPossiblyDirty === true;");
    expect(toolbarSource).toContain("return isTransactionActive.value;");
    // Both buttons are driven by the combined condition.
    expect(toolbarSource).toContain('<Tooltip v-if="showTxnActions">');
    expect(toolbarSource.match(/<Tooltip v-if="showTxnActions">/g)).toHaveLength(2);
  });

  it("exposes the transaction controls to assistive technology", () => {
    expect(toolbarSource).toContain(":aria-label=\"t('toolbar.commit')\"");
    expect(toolbarSource).toContain(":aria-label=\"t('toolbar.rollback')\"");
  });
});
