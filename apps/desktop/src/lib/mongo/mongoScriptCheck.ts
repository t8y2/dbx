import { parse, type Node } from "acorn";
import { MONGO_SCRIPT_RESULTS_UNAVAILABLE } from "./mongoScriptRecorder";

/**
 * Mongo shell JavaScript support for the query editor.
 *
 * Static checks run on the main thread before a script is recorded (see
 * mongoScriptRecorder.ts). A script runs once, off the main thread, to *record* the `db` calls it makes;
 * the recorded calls are then executed as ordinary editor commands, so they get
 * the same parser, safety checks and result handling as hand-written commands.
 *
 * Recording means a script never sees query results. That is only sound when
 * no result is ever read, so every `db` call must be a statement of its own
 * (`db.c.insertOne(...)`), never a value (`const doc = db.c.findOne(...)`,
 * `if (db.c.countDocuments())`). Scripts that would need results are rejected
 * up front instead of running against placeholder values.
 */

/** Whether the input parses as JavaScript at all; plain command typos keep the existing diagnostics. */
export function isMongoScriptSyntax(script: string): boolean {
  try {
    parseScript(script);
    return true;
  } catch {
    return false;
  }
}

function parseScript(script: string): Node {
  return parse(script, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: false });
}

/**
 * Static check that the script never reads a `db` call's result and cannot
 * reach `db` indirectly. Returns an error message, or null when the script is
 * safe to record.
 */
export function checkMongoScript(script: string): string | null {
  let program: Node;
  try {
    program = parseScript(script);
  } catch (error) {
    return `Script syntax error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const allowedRoots = new Set<Node>();
  const problems: string[] = [];
  visit(program, null, (node, parent) => {
    if (node.type === "ExpressionStatement") {
      const root = dbCallChainRoot((node as unknown as { expression: Node }).expression);
      if (root) allowedRoots.add(root);
      return;
    }
    if (node.type !== "Identifier") return;
    const name = (node as unknown as { name: string }).name;
    if (isPropertyName(node, parent)) return;
    if (name === "eval" || name === "arguments") problems.push(`${name} is not supported in Mongo scripts (${describeLocation(script, node)}).`);
    if (name === "db" && !allowedRoots.has(node)) problems.push(`${MONGO_SCRIPT_RESULTS_UNAVAILABLE} (${describeLocation(script, node)}).`);
  });
  return problems[0] ?? null;
}

/** The `db` identifier at the root of `db.x.method(...).chain(...)`, when the expression is exactly such a call chain. */
function dbCallChainRoot(expression: Node): Node | null {
  let current = expression as unknown as { type: string; callee?: unknown; object?: unknown; name?: string };
  if (current.type !== "CallExpression") return null;
  while (current.type === "CallExpression" || current.type === "MemberExpression") {
    current = (current.type === "CallExpression" ? current.callee : current.object) as typeof current;
  }
  return current.type === "Identifier" && current.name === "db" ? (current as unknown as Node) : null;
}

function isPropertyName(node: Node, parent: Node | null): boolean {
  if (!parent) return false;
  const p = parent as unknown as { type: string; property?: Node; computed?: boolean; key?: Node; shorthand?: boolean };
  if (p.type === "MemberExpression") return p.property === node && !p.computed;
  if (p.type === "Property" || p.type === "MethodDefinition" || p.type === "PropertyDefinition") return p.key === node && !p.computed && !p.shorthand;
  return false;
}

function visit(node: Node, parent: Node | null, callback: (node: Node, parent: Node | null) => void) {
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item, node, callback);
    } else if (isNode(value)) {
      visit(value, node, callback);
    }
  }
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function describeLocation(script: string, node: Node): string {
  const line = script.slice(0, node.start).split("\n").length;
  return `line ${line}`;
}
