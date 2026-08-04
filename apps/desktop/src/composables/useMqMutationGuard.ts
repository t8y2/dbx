import { unref, type MaybeRef } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

/**
 * Shared write guard for MQ console mutations.
 * Read-only is enforced by the backend; production connections require an
 * explicit confirmation (same dialog as SQL production writes).
 */
export function useMqMutationGuard(connectionId: MaybeRef<string>) {
  const connectionStore = useConnectionStore();
  const productionSafetyStore = useProductionSafetyStore();

  async function confirmMqWrite(operation: string): Promise<boolean> {
    const id = unref(connectionId);
    const config = connectionStore.getConfig(id);
    if (!config) return false;
    if (config.read_only) return false;
    if (!config.is_production) return true;
    return productionSafetyStore.requestConfirmation({
      sql: operation,
      connectionName: config.name,
      source: "mq",
    });
  }

  return { confirmMqWrite };
}
