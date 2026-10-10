import type { FunctionInfo } from "@/types/database";
import type { FunctionDiff, SchemaDiffRoutineValidation } from "./schemaDiff";

export async function preflightRoutineDeployment(expected: FunctionDiff[], loadSource: () => Promise<FunctionInfo[]>, validateTarget: (expected: FunctionDiff[]) => Promise<SchemaDiffRoutineValidation[]>, rollback = false, targetSchema?: string): Promise<void> {
  if (!expected.length) return;
  if (!rollback) {
    const current = await loadSource();
    for (const diff of expected) {
      const previous = diff.source;
      const kind = previous?.function_type ?? diff.target?.function_type;
      const matches = current.filter((info) => info.name === diff.name && info.function_type === kind);
      if (!previous ? matches.length !== 0 : matches.length !== 1 || matches[0]!.schema !== previous.schema || matches[0]!.status !== previous.status || matches[0]!.definition !== previous.definition || JSON.stringify(matches[0]!.dependencies ?? []) !== JSON.stringify(previous.dependencies ?? [])) {
        throw new Error("Routine source changed; reload comparison before executing");
      }
    }
  }
  const input = rollback
    ? expected.map((diff): FunctionDiff => {
        const originalOwner = `"${diff.source?.schema?.replaceAll('"', '""')}".`;
        const targetOwner = `"${targetSchema?.replaceAll('"', '""')}".`;
        return {
          ...diff,
          type: diff.type === "added" ? "removed" : diff.type === "removed" ? "added" : "modified",
          source: diff.target,
          target: diff.source ? { ...diff.source, schema: targetSchema, dependencies: diff.source.dependencies?.map((dependency) => (dependency.startsWith(originalOwner) ? targetOwner + dependency.slice(originalOwner.length) : dependency)) } : undefined,
        };
      })
    : expected;
  const results = await validateTarget(input);
  if (
    results.length !== input.length ||
    !input.every((diff) => {
      const kind = diff.source?.function_type ?? diff.target?.function_type;
      const matches = results.filter((result) => result.name === diff.name && result.routineType === kind);
      return matches.length === 1 && matches[0]!.success;
    })
  )
    throw new Error("Routine target preflight failed; reload comparison before executing");
}
