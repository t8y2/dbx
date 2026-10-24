import { watch } from "vue";
import { uuid } from "@/lib/common/utils";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { executeOracleTriggerPlan, type OracleTriggerExecutionResult, type OracleTriggerPlan, type OracleTriggerSnapshot, type OracleTriggerTarget } from "./oracleTriggerPlan";

/** Reuse the application's SQL preview/confirmation queue; no second execution dialog or executor. */
export async function confirmOracleTriggerPlan(plan: OracleTriggerPlan, options: { isCurrent: () => boolean; refresh?: (target: Readonly<OracleTriggerTarget>, snapshot?: OracleTriggerSnapshot) => Promise<void> }): Promise<OracleTriggerExecutionResult> {
  const danger = useSqlExecutionDangerStore();
  const production = useProductionSafetyStore();
  const scopeId = `oracle-trigger:${uuid()}`;
  const stop = watch(
    options.isCurrent,
    (current) => {
      if (!current) {
        danger.cancelScope(scopeId);
        production.cancelScope(scopeId);
      }
    },
    { flush: "sync" },
  );
  try {
    const connection = useConnectionStore().getConfig(plan.target.connectionId);
    const binding = plan.expectedAfter?.binding;
    const parent = binding ?? (plan.before.metadata.parent ? { scope: plan.before.metadata.parent.objectType, ...plan.before.metadata.parent } : { scope: plan.before.metadata.scope, owner: plan.before.metadata.scopeOwner });
    const targets = [`TRIGGER ${plan.target.owner}.${plan.target.name}`, `ON ${parent.scope}${parent.owner ? ` ${parent.owner}${"name" in parent && parent.name ? `.${parent.name}` : ""}` : ""}`, `${i18n.global.t("oracleTrigger.executionSchema")}: ${plan.target.executionSchema}`];
    if (plan.steps.length > 1) targets.push(i18n.global.t("oracleTrigger.nonAtomic"));
    const confirmed =
      options.isCurrent() &&
      (plan.steps.length === 0 ||
        (await danger.requestConfirmation({
          sql: plan.steps.map((step) => step.sql).join("\n\n"),
          kind: "sql",
          connectionName: connection?.name,
          database: plan.target.database,
          targetLabel: targets.join("\n"),
          databaseType: plan.before.metadata.engine === "dm" ? "dameng" : plan.before.metadata.engine,
          scopeId,
        })));
    return await executeOracleTriggerPlan(plan, { confirmed, confirmationScope: scopeId, ...options });
  } finally {
    stop();
    danger.cancelScope(scopeId);
    production.cancelScope(scopeId);
  }
}
