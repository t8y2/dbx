import { computed, onScopeDispose, ref, type ComputedRef, type Ref, type WritableComputedRef } from "vue";
import type { DataGridSaveConfirmationRequest } from "@/composables/useDataGridEditor";

/**
 * Salesforce writes go out as one REST call per record and cannot be rolled back,
 * so every grid save is reviewed before it runs. This composable turns the
 * `confirmSaveRequest` hook from `useDataGridEditor` into a dialog decision:
 * `request()` parks the save on a promise the dialog settles.
 *
 * The pending request is transient — never persisted and never outliving the
 * component — so a dismissed grid denies the write instead of leaving it hanging.
 */
export function useSalesforceSaveConfirmation(): {
  pending: Ref<DataGridSaveConfirmationRequest | null>;
  open: WritableComputedRef<boolean>;
  updates: ComputedRef<number>;
  inserts: ComputedRef<number>;
  deletes: ComputedRef<number>;
  total: ComputedRef<number>;
  targetLabel: ComputedRef<string | undefined>;
  statements: ComputedRef<string[]>;
  request: (request: DataGridSaveConfirmationRequest) => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
} {
  const pending = ref<DataGridSaveConfirmationRequest | null>(null);
  let resolvePending: ((confirmed: boolean) => void) | undefined;

  const open = computed({
    get: () => !!pending.value,
    set: (next: boolean) => {
      if (!next) settle(false);
    },
  });

  const updates = computed(() => pending.value?.updates ?? 0);
  const inserts = computed(() => pending.value?.inserts ?? 0);
  const deletes = computed(() => pending.value?.deletes ?? 0);
  const total = computed(() => updates.value + inserts.value + deletes.value);
  const targetLabel = computed(() => pending.value?.targetLabel);
  const statements = computed(() => pending.value?.statements ?? []);

  function settle(confirmed: boolean) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = null;
    resolve?.(confirmed);
  }

  function request(saveRequest: DataGridSaveConfirmationRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (pending.value) {
        // A grid only saves once at a time, but never strand a second caller:
        // deny it so that save unwinds instead of waiting on a dialog it cannot see.
        resolve(false);
        return;
      }
      pending.value = saveRequest;
      resolvePending = resolve;
    });
  }

  function confirm() {
    settle(true);
  }

  function cancel() {
    settle(false);
  }

  // The dialog is the only way to settle the promise; if it goes away first (tab
  // closed mid-review) the parked save must be denied, not leaked.
  onScopeDispose(() => settle(false));

  return { pending, open, updates, inserts, deletes, total, targetLabel, statements, request, confirm, cancel };
}
