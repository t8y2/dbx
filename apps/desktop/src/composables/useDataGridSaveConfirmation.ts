import { computed, onScopeDispose, ref, type ComputedRef, type Ref, type WritableComputedRef } from "vue";
import type { DataGridSaveConfirmationRequest } from "@/composables/useDataGridEditor";

/** Parks a grid save until its confirmation dialog explicitly accepts or rejects it. */
export function useDataGridSaveConfirmation(): {
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

  onScopeDispose(() => settle(false));

  return { pending, open, updates, inserts, deletes, total, targetLabel, statements, request, confirm, cancel };
}
