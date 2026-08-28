import { toValue, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import { useToast } from "@/composables/useToast";

/**
 * Shared write guard for MQ console mutations.
 * Read-only is enforced by the backend; production connections require an
 * explicit confirmation (same dialog as SQL production writes).
 */
export function useMqMutationGuard(connectionId: MaybeRefOrGetter<string>) {
  const connectionStore = useConnectionStore();
  const productionSafetyStore = useProductionSafetyStore();
  const { toast } = useToast();
  const { t } = useI18n();

  async function confirmMqWrite(operation: string): Promise<boolean> {
    // Call sites pass () => props.connectionId — must use toValue (not unref)
    // so getters resolve to the real connection id.
    const id = toValue(connectionId);
    const config = connectionStore.getConfig(id);
    if (!config) {
      toast(t("mqAdmin.connectionMissing"));
      return false;
    }
    if (!(await ensureReadOnlyWriteAccess({ connection: config, sql: operation, source: t("production.sourceMq"), treatAsMutation: true }))) {
      return false;
    }
    if (!config.is_production) return true;
    return productionSafetyStore.requestConfirmation({
      sql: operation,
      connectionName: config.name,
      source: t("production.sourceMq"),
    });
  }

  return { confirmMqWrite };
}
