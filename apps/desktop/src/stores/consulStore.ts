import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import * as api from "@/lib/backend/api";
import type { ConsulScope } from "@/types/consul";

function emptyScope(): ConsulScope {
  return { datacenter: "", namespace: "", partition: "" };
}

export const useConsulStore = defineStore("consul", () => {
  const activeConnectionId = ref("");
  const scope = reactive<ConsulScope>(emptyScope());
  const generation = ref(0);
  const activeOperations = reactive(new Map<string, { connectionId: string; scope: ConsulScope; generation: number }>());

  const scopeKey = computed(() => `${scope.datacenter}\0${scope.partition}\0${scope.namespace}`);

  function bindConnection(connectionId: string, nextScope: ConsulScope = emptyScope()) {
    if (activeConnectionId.value === connectionId && scopeKey.value === scopeIdentity(nextScope)) return;
    invalidate();
    activeConnectionId.value = connectionId;
    Object.assign(scope, nextScope);
  }

  function switchScope(nextScope: ConsulScope) {
    if (scopeKey.value === scopeIdentity(nextScope)) return;
    invalidate();
    Object.assign(scope, nextScope);
  }

  function registerOperation(operationId: string) {
    if (activeOperations.has(operationId)) throw new Error("CONSUL_OPERATION_ALREADY_RUNNING");
    activeOperations.set(operationId, {
      connectionId: activeConnectionId.value,
      scope: { ...scope },
      generation: generation.value,
    });
  }

  function completeOperation(operationId: string) {
    activeOperations.delete(operationId);
  }

  function invalidate() {
    for (const [operationId, operation] of activeOperations) {
      void api.consulCancelBlocking(operation.connectionId, operation.scope, operation.generation, operationId).catch(() => undefined);
    }
    activeOperations.clear();
    generation.value += 1;
  }

  return {
    activeConnectionId,
    scope,
    scopeKey,
    generation,
    bindConnection,
    switchScope,
    registerOperation,
    completeOperation,
    invalidate,
  };
});

function scopeIdentity(scope: ConsulScope): string {
  return `${scope.datacenter}\0${scope.partition}\0${scope.namespace}`;
}
