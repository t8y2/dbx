import { readonly, shallowRef } from "vue";
import { uuid } from "@/lib/common/utils";
import type { OracleTypeManagementSnapshot } from "@/types/database";
import type { TypeManagementOperation, TypeManagementTarget } from "@/lib/table/oracleTypeManagement";

export interface TypeManagementRequest {
  id: string;
  target: TypeManagementTarget;
  operation: TypeManagementOperation;
  source?: string;
  baseSource?: string;
  tabId?: string;
  isCurrent?: () => boolean;
}
export interface TypeManagementOutcome {
  complete: boolean;
  target: TypeManagementTarget;
  operation: TypeManagementOperation;
  snapshot?: OracleTypeManagementSnapshot;
}

const current = shallowRef<TypeManagementRequest | null>(null);
let resolveCurrent: ((outcome: TypeManagementOutcome) => void) | undefined;
export const oracleTypeManagementRequest = readonly(current);

/** The existing navigation surfaces share one confirmation surface and one durable source tab. */
export function requestOracleTypeManagement(input: Omit<TypeManagementRequest, "id">): Promise<TypeManagementOutcome> {
  if (current.value) return Promise.reject(new Error("Finish or close the current TYPE preview before starting another."));
  return new Promise((resolve) => {
    resolveCurrent = resolve;
    current.value = { ...input, target: { ...input.target }, id: uuid() };
  });
}

export function finishOracleTypeManagementRequest(id: string, outcome: TypeManagementOutcome) {
  if (current.value?.id !== id) return;
  const resolve = resolveCurrent;
  resolveCurrent = undefined;
  current.value = null;
  resolve?.(outcome);
}
