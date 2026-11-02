import { describe, expect, it } from "vitest";
import { effectScope, type EffectScope } from "vue";
import { useSalesforceSaveConfirmation } from "@/composables/useSalesforceSaveConfirmation";
import type { DataGridSaveConfirmationRequest } from "@/composables/useDataGridEditor";

const saveRequest: DataGridSaveConfirmationRequest = {
  updates: 2,
  inserts: 1,
  deletes: 0,
  targetLabel: "Account",
  statements: ['DBX SALESFORCE DML\n{"op":"update","object":"Account","id":"001xx000003DGbY","fields":{"Name":"Acme"}}'],
};

function createConfirmation(): { scope: EffectScope; confirmation: ReturnType<typeof useSalesforceSaveConfirmation> } {
  const scope = effectScope();
  const confirmation = scope.run(() => useSalesforceSaveConfirmation());
  if (!confirmation) throw new Error("useSalesforceSaveConfirmation must run inside an effect scope");
  return { scope, confirmation };
}

describe("useSalesforceSaveConfirmation", () => {
  it("parks the save until the dialog confirms and exposes the batch summary", async () => {
    const { confirmation } = createConfirmation();
    const decision = confirmation.request(saveRequest);

    expect(confirmation.open.value).toBe(true);
    expect(confirmation.pending.value).toEqual(saveRequest);
    expect(confirmation.updates.value).toBe(2);
    expect(confirmation.inserts.value).toBe(1);
    expect(confirmation.deletes.value).toBe(0);
    expect(confirmation.total.value).toBe(3);
    expect(confirmation.targetLabel.value).toBe("Account");
    expect(confirmation.statements.value).toEqual(saveRequest.statements);
    // The save stays parked: nothing is written to Salesforce until the operator decides.
    await Promise.resolve();
    expect(confirmation.open.value).toBe(true);

    confirmation.confirm();

    await expect(decision).resolves.toBe(true);
    expect(confirmation.open.value).toBe(false);
    expect(confirmation.pending.value).toBeNull();
  });

  it("denies the save when the dialog is dismissed", async () => {
    const { confirmation } = createConfirmation();
    const decision = confirmation.request(saveRequest);

    // `v-model:open` writes false on Cancel, Escape and backdrop clicks alike.
    confirmation.open.value = false;

    await expect(decision).resolves.toBe(false);
    expect(confirmation.pending.value).toBeNull();
  });

  it("denies a second concurrent save instead of leaving it waiting on a hidden dialog", async () => {
    const { confirmation } = createConfirmation();
    const first = confirmation.request(saveRequest);

    await expect(confirmation.request({ ...saveRequest, updates: 5 })).resolves.toBe(false);

    expect(confirmation.open.value).toBe(true);
    expect(confirmation.updates.value).toBe(2);
    confirmation.confirm();
    await expect(first).resolves.toBe(true);
  });

  it("denies a parked save when the grid is torn down mid-review", async () => {
    const { scope, confirmation } = createConfirmation();
    const decision = confirmation.request(saveRequest);

    scope.stop();

    await expect(decision).resolves.toBe(false);
  });

  it("reports an empty summary before any save is requested", () => {
    const { confirmation } = createConfirmation();

    expect(confirmation.open.value).toBe(false);
    expect(confirmation.total.value).toBe(0);
    expect(confirmation.statements.value).toEqual([]);
    expect(confirmation.targetLabel.value).toBeUndefined();
  });
});
