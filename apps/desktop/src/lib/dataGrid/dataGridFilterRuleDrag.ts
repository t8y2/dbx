export type DataGridFilterRuleDropPlacement = {
  ruleId: string;
  position: "before" | "after";
  targetIndex: number;
};

export type DataGridFilterRuleBounds = {
  id: string;
  top: number;
  bottom: number;
};

export function resolveDataGridFilterRuleDropPlacement(ruleIds: readonly string[], draggingRuleId: string, rowBounds: readonly DataGridFilterRuleBounds[], clientY: number): DataGridFilterRuleDropPlacement | undefined {
  const remainingRuleIds = ruleIds.filter((id) => id !== draggingRuleId);
  const boundsById = new Map(rowBounds.map((bounds) => [bounds.id, bounds]));
  const boundedRules = remainingRuleIds.flatMap((id, targetIndex) => {
    const bounds = boundsById.get(id);
    return bounds ? [{ id, targetIndex, bounds }] : [];
  });
  if (!boundedRules.length) return undefined;

  const nextRule = boundedRules.find(({ bounds }) => clientY < bounds.top + (bounds.bottom - bounds.top) / 2);
  if (nextRule) return { ruleId: nextRule.id, position: "before", targetIndex: nextRule.targetIndex };

  const lastRule = boundedRules[boundedRules.length - 1];
  return { ruleId: lastRule.id, position: "after", targetIndex: remainingRuleIds.length };
}
