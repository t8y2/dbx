import type { ExplainPlanNode, ParsedExplainPlan } from "./explainPlan";

const MAX_OPERATORS = 2_000;
const MAX_STREAMS = 10_000;
const MAX_DETAILS = 10_000;
const MAX_DEPTH = 128;
const MAX_DISPLAY_NODES = 5_000;
const MAX_RAW_LENGTH = 5 * 1024 * 1024;

type RecordValue = Record<string, unknown>;
interface Operator {
  id: string;
  node: ExplainPlanNode;
  children: Array<{ id: string; streamId: string }>;
  outputRows: Set<string>;
}

function fail(message: string): never {
  throw new Error(`DB2 EXPLAIN: ${message}`);
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`);
  return value as RecordValue;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`missing or invalid ${label}`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Keep decimal strings intact: DB2 costs/cardinalities can exceed JS precision. */
function numericText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  return text && /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? text : undefined;
}

function records(value: unknown, label: string, limit: number, optional = false): RecordValue[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) fail(`invalid ${label}`);
  if (value.length > limit) fail(`${label} exceed the supported size (${limit})`);
  return value.map((entry) => record(entry, label));
}

/** Parse the versioned JSON returned by Db2Agent.getExplainInfo(), never db2exfmt text. */
export function parseDb2ExplainText(raw: string): ParsedExplainPlan {
  if (raw.length > MAX_RAW_LENGTH) fail("plan exceeds the supported size");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    fail("invalid JSON plan");
  }
  const payload = record(decoded, "plan");
  if (payload.version !== 1) fail(`unsupported plan version: ${String(payload.version)}`);
  if (payload.databaseType !== "db2") fail("invalid database type");
  requiredText(payload.requestTag, "request tag");

  const operators = new Map<string, Operator>();
  for (const value of records(payload.operators, "operators", MAX_OPERATORS)) {
    const id = requiredText(value.id, "operator ID");
    if (operators.has(id)) fail(`duplicate operator ID: ${id}`);
    const nodeType = requiredText(value.type, "operator type");
    const cost = numericText(value.totalCost);
    const details: string[] = [];
    for (const [field, label, unit] of [
      ["totalCost", "Total Cost", "timerons"],
      ["ioCost", "I/O Cost", "page I/Os"],
      ["cpuCost", "CPU Cost", "instructions"],
      ["firstRowCost", "First Row Cost", "timerons"],
    ] as const) {
      const number = numericText(value[field]);
      if (number !== undefined) details.push(`${label}: ${number} ${unit}`);
    }
    operators.set(id, {
      id,
      node: { id: `db2-operator-${id}`, title: nodeType, nodeType, dialect: "db2", cost: cost === undefined ? undefined : `${cost} timerons`, costModel: "unknown", details, children: [] },
      children: [],
      outputRows: new Set(),
    });
  }
  if (!operators.size) fail("no plan operators returned");

  const getOperator = (id: string): Operator => operators.get(id) ?? fail(`dangling operator reference: ${id}`);
  const hasParent = new Set<string>();
  const streamIds = new Set<string>();
  for (const value of records(payload.streams, "streams", MAX_STREAMS)) {
    const streamId = requiredText(value.id, "stream ID");
    if (streamIds.has(streamId)) fail(`duplicate stream ID: ${streamId}`);
    streamIds.add(streamId);
    const sourceType = requiredText(value.sourceType, "stream source type").toUpperCase();
    const targetType = requiredText(value.targetType, "stream target type").toUpperCase();
    const sourceId = requiredText(value.sourceId, "stream source ID");
    const targetId = requiredText(value.targetId, "stream target ID");
    const source = sourceType === "O" ? getOperator(sourceId) : undefined;
    const target = targetType === "O" ? getOperator(targetId) : undefined;
    const rowCount = numericText(value.rowCount);
    // Streams run from input to consumer: source operator is the consumer's child.
    if (source && target) {
      if (!target.children.some((child) => child.id === sourceId)) target.children.push({ id: sourceId, streamId });
      hasParent.add(sourceId);
    }
    if (source && rowCount !== undefined) source.outputRows.add(rowCount);
    // D denotes a data object (usually ID -1), never a vertex in the operator graph.
    const objectOperator = source && !target ? source : target && !source ? target : undefined;
    const objectName = optionalText(value.objectName);
    if (objectOperator && objectName) {
      const schema = optionalText(value.objectSchema);
      const name = schema ? `${schema}.${objectName}` : objectName;
      const node = objectOperator.node;
      node.details.push(`Object: ${name}`);
      if (node.nodeType.toUpperCase() === "IXSCAN") node.index ??= name;
      else node.relation ??= name;
      node.title = `${node.nodeType} on ${node.index ?? node.relation}`;
    }
  }

  for (const value of records(payload.predicates, "predicates", MAX_DETAILS, true)) {
    const operator = getOperator(requiredText(value.operatorId, "predicate operator ID"));
    const text = optionalText(value.text);
    const howApplied = optionalText(value.howApplied);
    if (text) operator.node.details.push(`Predicate${howApplied ? ` (${howApplied})` : ""}: ${text}`);
  }
  for (const value of records(payload.arguments, "arguments", MAX_DETAILS, true)) {
    const operator = getOperator(requiredText(value.operatorId, "argument operator ID"));
    const type = optionalText(value.type);
    const text = optionalText(value.value);
    if (type && text) operator.node.details.push(`${type}: ${text}`);
  }

  // Validate every component, including cycles disconnected from valid roots.
  const heights = new Map<string, number>();
  const visiting = new Set<string>();
  function validate(id: string, depth: number): number {
    if (depth > MAX_DEPTH) fail(`plan exceeds the supported depth (${MAX_DEPTH})`);
    if (visiting.has(id)) fail(`cycle involving operator: ${id}`);
    const known = heights.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let height = 1;
    for (const child of getOperator(id).children) height = Math.max(height, 1 + validate(child.id, depth + 1));
    visiting.delete(id);
    if (height > MAX_DEPTH) fail(`plan exceeds the supported depth (${MAX_DEPTH})`);
    heights.set(id, height);
    return height;
  }
  for (const operator of operators.values()) {
    validate(operator.id, 1);
    // Multiple streams with different estimates have no single reliable cardinality.
    if (operator.outputRows.size === 1) operator.node.rows = [...operator.outputRows][0];
  }

  const displayed = new Set<string>();
  let displayCount = 0;
  function display(id: string, streamId?: string): ExplainPlanNode {
    if (++displayCount > MAX_DISPLAY_NODES) fail(`display exceeds the supported size (${MAX_DISPLAY_NODES})`);
    const operator = getOperator(id);
    if (displayed.has(id)) {
      // A DAG must not expand exponentially into the viewer's tree model.
      return { ...operator.node, id: `db2-reference-${streamId}`, title: `${operator.node.title} (reference)`, details: [...operator.node.details, `Reference to operator ${id}`], children: [] };
    }
    displayed.add(id);
    return { ...operator.node, children: operator.children.map((child) => display(child.id, child.streamId)) };
  }
  const nodes = [...operators.values()].filter((operator) => !hasParent.has(operator.id)).map((operator) => display(operator.id));
  return { databaseType: "db2", raw, nodes };
}
