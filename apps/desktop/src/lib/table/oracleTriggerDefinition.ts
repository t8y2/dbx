interface Token {
  text: string;
  start: number;
  end: number;
  kind: "word" | "identifier" | "literal" | "symbol";
}
interface Span {
  start: number;
  end: number;
}

export interface OracleTriggerFields {
  timing: string;
  events: string;
  referencing: string;
  rowLevel: boolean;
  when: string;
  body: string;
}

export interface OracleTriggerDefinition {
  source: string;
  schema?: string;
  name: string;
  tableSchema?: string;
  tableName?: string;
  identityStart: number;
  tableStart?: number;
  tableEnd?: number;
  structured: boolean;
  reason?: string;
  fields?: OracleTriggerFields;
  spans?: Record<keyof OracleTriggerFields, Span>;
  createEnd: number;
  replace: boolean;
}

export function oracleTriggerOwner(trigger: { name: string; owner?: string | null; statement?: string | null }): string | undefined {
  if (trigger.owner) return trigger.owner;
  if (!trigger.statement) return undefined;
  try {
    const definition = parseOracleTriggerDefinition(trigger.statement);
    return definition.name === trigger.name ? definition.schema : undefined;
  } catch {
    return undefined;
  }
}

// Keep source offsets, including comments and whitespace, so unchanged fields
// do not pass through a serializer. Oracle q/nq literals can contain apostrophes.
function scan(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unclosed trigger comment");
      i = end + 2;
      continue;
    }
    const start = i;
    const alternative = /^(?:nq|q)'/i.exec(source.slice(i));
    if (alternative) {
      const open = source[i + alternative[0].length];
      const close = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
      const end = source.indexOf(`${close}'`, i + alternative[0].length + 1);
      if (!open || /\s/.test(open) || end < 0) throw new Error("Unclosed trigger alternative literal");
      i = end + 2;
      tokens.push({ text: source.slice(start, i), start, end: i, kind: "literal" });
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++];
      let closed = false;
      while (i < source.length) {
        if (source[i++] !== quote) continue;
        if (source[i] === quote) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error("Unclosed trigger quoted token");
      tokens.push({ text: source.slice(start, i), start, end: i, kind: quote === '"' ? "identifier" : "literal" });
      continue;
    }
    const word = /^[\p{L}_$#][\p{L}\p{N}_$#]*/u.exec(source.slice(i));
    if (word) {
      i += word[0].length;
      tokens.push({ text: word[0], start, end: i, kind: "word" });
    } else {
      i++;
      tokens.push({ text: source[start], start, end: i, kind: "symbol" });
    }
  }
  return tokens;
}

function identifier(token: Token | undefined): string {
  if (token?.kind === "identifier") return token.text.slice(1, -1).replaceAll('""', '"');
  if (token?.kind === "word") return token.text.toUpperCase();
  throw new Error("Expected a trigger identifier");
}

function definitionEnd(source: string, tokens: Token[], identity: { schema?: string; name: string }): number {
  const alters = tokens.flatMap((token, index) => (token.kind === "word" && token.text.toUpperCase() === "ALTER" ? [index] : []));
  let end = source.length;
  if (alters.length) {
    if (alters.length !== 1) throw new Error("Only one matching trigger state clause may follow the definition");
    let index = alters[0];
    end = tokens[index++].start;
    if (tokens[index]?.kind !== "word" || tokens[index++].text.toUpperCase() !== "TRIGGER") throw new Error("Only a matching ALTER TRIGGER state clause may follow the definition");
    let name = identifier(tokens[index++]);
    let schema: string | undefined;
    if (tokens[index]?.text === ".") {
      index++;
      schema = name;
      name = identifier(tokens[index++]);
    }
    if (name !== identity.name || (schema !== undefined && identity.schema !== undefined && schema !== identity.schema)) throw new Error("Trailing trigger state clause has a different identity");
    const state = tokens[index++];
    if (state?.kind !== "word" || !["ENABLE", "DISABLE"].includes(state.text.toUpperCase())) throw new Error("Unsupported trailing trigger state clause");
    if (tokens[index]?.text === ";") index++;
    if (tokens[index]?.text === "/") index++;
    if (index !== tokens.length) throw new Error("Additional statements cannot be saved with a trigger definition");
  }
  const definition = source.slice(0, end);
  const slash = /\r?\n[ \t]*\/[ \t]*(?:\r?\n[ \t]*)*$/.exec(definition);
  return slash?.index ?? end;
}

export function parseOracleTriggerDefinition(source: string): OracleTriggerDefinition {
  const tokens = scan(source);
  let index = 0;
  const is = (word: string) => tokens[index]?.kind === "word" && tokens[index].text.toUpperCase() === word;
  const requireWord = (word: string) => {
    if (!is(word)) throw new Error(`Expected ${word} in trigger definition`);
    return tokens[index++];
  };
  const name = () => {
    const first = identifier(tokens[index++]);
    if (tokens[index]?.text !== ".") return { name: first, schema: undefined };
    index++;
    return { schema: first, name: identifier(tokens[index++]) };
  };
  const createEnd = requireWord("CREATE").end;
  let replace = false;
  if (is("OR")) {
    index++;
    requireWord("REPLACE");
    replace = true;
  }
  if (is("EDITIONABLE") || is("NONEDITIONABLE")) index++;
  requireWord("TRIGGER");
  const identityStart = tokens[index]?.start;
  const identity = name();
  const sourceEnd = definitionEnd(source, tokens, identity);
  const result: OracleTriggerDefinition = { source, ...identity, identityStart: identityStart!, structured: false, createEnd, replace };
  const fallback = (reason: string) => ({ ...result, reason });
  const timingStart = tokens[index]?.start;
  if (timingStart === undefined) return fallback("Missing trigger timing");
  if (is("BEFORE") || is("AFTER") || is("FOR")) index++;
  else if (is("INSTEAD")) {
    index++;
    requireWord("OF");
  } else return fallback("Compound or special trigger: edit the complete source");
  const timingEnd = tokens[index - 1].end;
  const eventsStart = tokens[index]?.start;
  while (index < tokens.length && !is("ON")) {
    if (tokens[index].text === ";") return fallback("Unrecognized trigger events");
    index++;
  }
  if (eventsStart === undefined || index === tokens.length) return fallback("Missing trigger target");
  const eventsEnd = tokens[index - 1].end;
  const eventTokens = tokens.filter((token) => token.start >= eventsStart && token.end <= eventsEnd);
  if (!eventTokens.some((token) => token.kind === "word" && ["INSERT", "UPDATE", "DELETE"].includes(token.text.toUpperCase()))) return fallback("System trigger: edit the complete source");
  index++;
  const nestedTarget = is("NESTED");
  try {
    if (nestedTarget) {
      index++;
      requireWord("TABLE");
      identifier(tokens[index++]);
      requireWord("OF");
    }
    result.tableStart = tokens[index]?.start;
    const table = name();
    result.tableName = table.name;
    result.tableSchema = table.schema;
    result.tableEnd = tokens[index - 1].end;
  } catch {
    return fallback("Special trigger target: edit the complete source");
  }
  if (nestedTarget) return fallback("Nested table trigger: edit the complete source");
  let referencingSpan: Span | undefined;
  let rowSpan: Span | undefined;
  let whenSpan: Span | undefined;
  let referencing = "";
  let when = "";
  if (is("REFERENCING")) {
    const start = tokens[index++].start;
    const contentStart = tokens[index]?.start;
    while (is("OLD") || is("NEW") || is("PARENT")) {
      index++;
      if (is("AS")) index++;
      identifier(tokens[index++]);
    }
    referencingSpan = { start, end: tokens[index - 1].end };
    referencing = source.slice(contentStart, referencingSpan.end);
  }
  if (is("FOR")) {
    const start = tokens[index++].start;
    requireWord("EACH");
    const end = requireWord("ROW").end;
    rowSpan = { start, end };
  }
  const enabledStart = is("ENABLE") || is("DISABLE") ? tokens[index++].start : undefined;
  if (is("WHEN")) {
    const start = tokens[index++].start;
    if (tokens[index]?.text !== "(") return fallback("Unrecognized WHEN clause");
    const contentStart = tokens[index++].end;
    let depth = 1;
    while (index < tokens.length && depth > 0) {
      const token = tokens[index++];
      if (token.kind === "symbol" && token.text === "(") depth++;
      if (token.kind === "symbol" && token.text === ")") depth--;
    }
    if (depth !== 0) return fallback("Unclosed WHEN clause");
    const closing = tokens[index - 1];
    when = source.slice(contentStart, closing.start);
    whenSpan = { start, end: closing.end };
  }
  if (!is("BEGIN") && !is("DECLARE") && !is("CALL")) return fallback("Ordering, edition or compound clauses: edit the complete source");
  const bodyStart = tokens[index].start;
  // A SQL*Plus slash belongs to the transport, not the PL/SQL definition.
  const bodyEnd = sourceEnd;
  const insertAt = enabledStart ?? whenSpan?.start ?? bodyStart;
  return {
    ...result,
    structured: true,
    fields: { timing: source.slice(timingStart, timingEnd), events: source.slice(eventsStart, eventsEnd), referencing, rowLevel: !!rowSpan, when, body: source.slice(bodyStart, bodyEnd) },
    spans: {
      timing: { start: timingStart, end: timingEnd },
      events: { start: eventsStart, end: eventsEnd },
      referencing: referencingSpan ?? { start: rowSpan?.start ?? insertAt, end: rowSpan?.start ?? insertAt },
      rowLevel: rowSpan ?? { start: insertAt, end: insertAt },
      when: whenSpan ?? { start: bodyStart, end: bodyStart },
      body: { start: bodyStart, end: bodyEnd },
    },
  };
}

export function updateOracleTriggerDefinition(definition: OracleTriggerDefinition, fields: OracleTriggerFields): string {
  if (!definition.structured || !definition.fields || !definition.spans) throw new Error("This trigger requires complete source editing");
  if (fields.when.trim() && !fields.rowLevel) throw new Error("WHEN requires a row-level trigger");
  const replacements: Array<Span & { value: string; order: number }> = [];
  const keys: Array<keyof OracleTriggerFields> = ["timing", "events", "referencing", "rowLevel", "when", "body"];
  keys.forEach((key, order) => {
    if (fields[key] === definition.fields![key]) return;
    const span = definition.spans![key];
    let value = String(fields[key]);
    if (key === "referencing") value = fields.referencing.trim() ? `REFERENCING ${fields.referencing}` : "";
    if (key === "rowLevel") value = fields.rowLevel ? "FOR EACH ROW" : "";
    if (key === "when") value = fields.when.trim() ? `WHEN (${fields.when})` : "";
    if (span.start === span.end && value) value += "\n";
    replacements.push({ ...span, value, order });
  });
  let source = definition.source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start || b.order - a.order)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  return source;
}

function triggerHeaderBoundary(tokens: Token[], tableEnd: number | undefined): { body: number; insertion: number; state?: Token } {
  if (tableEnd === undefined) throw new Error("Cannot locate the trigger target safely");
  let index = tokens.findIndex((token) => token.start >= tableEnd);
  const is = (word: string) => tokens[index]?.kind === "word" && tokens[index].text.toUpperCase() === word;
  const requireWord = (word: string) => {
    if (!is(word)) throw new Error(`Expected ${word} in trigger header`);
    index++;
  };
  const name = () => {
    identifier(tokens[index++]);
    if (tokens[index]?.text === ".") {
      index++;
      identifier(tokens[index++]);
    }
  };
  if (is("REFERENCING")) {
    index++;
    while (is("OLD") || is("NEW") || is("PARENT")) {
      index++;
      if (is("AS")) index++;
      identifier(tokens[index++]);
    }
  }
  if (is("FOR")) {
    index++;
    requireWord("EACH");
    requireWord("ROW");
  }
  if (is("FORWARD") || is("REVERSE")) {
    index++;
    requireWord("CROSSEDITION");
  }
  if (is("FOLLOWS") || is("PRECEDES")) {
    index++;
    name();
    while (tokens[index]?.text === ",") {
      index++;
      name();
    }
  }
  const state = is("ENABLE") || is("DISABLE") ? tokens[index++] : undefined;
  const insertion = tokens[index]?.start;
  if (is("WHEN")) {
    index++;
    if (tokens[index]?.text !== "(") throw new Error("Unrecognized WHEN clause");
    let depth = 0;
    do {
      const token = tokens[index++];
      if (!token) throw new Error("Unclosed WHEN clause");
      if (token.kind === "symbol" && token.text === "(") depth++;
      if (token.kind === "symbol" && token.text === ")") depth--;
    } while (depth);
  }
  if (insertion === undefined || !["COMPOUND", "DECLARE", "BEGIN", "CALL"].some(is)) throw new Error("Cannot locate the trigger body safely");
  return { body: index, insertion, state };
}

function requireSingleTriggerBody(tokens: Token[], body: number): void {
  if (tokens[body].text.toUpperCase() === "CALL") {
    const end = tokens.findIndex((token, index) => index >= body && token.text === ";" && token.kind === "symbol");
    if (end >= 0 && end !== tokens.length - 1) throw new Error("Additional statements follow the trigger call");
    return;
  }
  const compound = tokens[body].text.toUpperCase() === "COMPOUND";
  const stack: string[] = compound ? ["COMPOUND", "DECLARATION"] : [];
  let closed = false;
  for (let index = body + (compound ? 2 : 0); index < tokens.length; index++) {
    const token = tokens[index];
    const top = () => stack[stack.length - 1];
    if (token.kind === "symbol" && token.text === ";") {
      if (top() === "ROUTINE_HEADER") stack.pop();
      if (closed && !stack.length) {
        if (index !== tokens.length - 1) throw new Error("Additional statements follow the trigger body");
        return;
      }
    }
    if (token.kind !== "word") continue;
    const word = token.text.toUpperCase();
    if (word === "DECLARE") stack.push("DECLARATION");
    else if (["PROCEDURE", "FUNCTION"].includes(word) && ["DECLARATION", "ROUTINE"].includes(top() ?? "")) stack.push("ROUTINE_HEADER");
    else if (["IS", "AS"].includes(word) && top() === "ROUTINE_HEADER") stack[stack.length - 1] = "ROUTINE";
    else if (word === "BEGIN") {
      if (["DECLARATION", "ROUTINE"].includes(top() ?? "")) stack[stack.length - 1] = "BLOCK";
      else stack.push("BLOCK");
    } else if (["IF", "LOOP", "CASE"].includes(word)) stack.push(word);
    else if (word === "END") {
      const next = tokens[index + 1];
      const terminator = next?.kind === "word" ? next.text.toUpperCase() : "";
      if (top() === "CASE") {
        stack.pop();
        if (terminator === "CASE") index++;
      } else if (["IF", "LOOP"].includes(terminator)) {
        if (top() !== terminator) throw new Error("Unbalanced trigger block");
        stack.pop();
        index++;
      } else {
        // Compound declarations belong to the trigger, outside its timing sections.
        if (top() === "DECLARATION" && stack[stack.length - 2] === "COMPOUND") stack.pop();
        if (!["BLOCK", "COMPOUND"].includes(top() ?? "")) throw new Error("Unbalanced trigger block");
        stack.pop();
      }
      closed = true;
    }
  }
  throw new Error("Trigger body must end with a complete END statement");
}

interface TriggerReplacementIdentity {
  schema: string;
  name: string;
  tableSchema?: string;
  tableName?: string;
}

export function prepareOracleTriggerReplacement(source: string, expected: TriggerReplacementIdentity): string {
  const definition = parseOracleTriggerDefinition(source);
  if (definition.name !== expected.name || (definition.schema ?? expected.schema) !== expected.schema) throw new Error("Trigger identity differs from the selected object");
  if (expected.tableSchema !== undefined || expected.tableName !== undefined) {
    if (!expected.tableSchema || !expected.tableName) throw new Error("Selected trigger target identity is incomplete");
    if (definition.tableName !== expected.tableName || (definition.tableSchema ?? expected.tableSchema) !== expected.tableSchema) throw new Error("Replacement trigger target differs from the selected table");
  }
  const tokens = scan(source);
  const end = definitionEnd(source, tokens, { schema: definition.schema ?? expected.schema, name: definition.name });
  let singleDefinition = source.slice(0, end);
  const definitionTokens = tokens.filter((token) => token.start < end);
  if (definitionTokens.slice(1).some((token) => token.kind === "word" && ["DROP", "CREATE", "ALTER"].includes(token.text.toUpperCase()))) throw new Error("Additional DDL cannot be saved with a trigger definition");
  requireSingleTriggerBody(definitionTokens, triggerHeaderBoundary(definitionTokens, definition.tableEnd).body);
  const qualifiers: Array<{ start: number; schema: string }> = [];
  if (!definition.schema) qualifiers.push({ start: definition.identityStart, schema: expected.schema });
  if (!definition.tableSchema && expected.tableSchema && definition.tableStart !== undefined) qualifiers.push({ start: definition.tableStart, schema: expected.tableSchema });
  for (const qualifier of qualifiers.sort((a, b) => b.start - a.start)) {
    singleDefinition = singleDefinition.slice(0, qualifier.start) + `"${qualifier.schema.replaceAll('"', '""')}".` + singleDefinition.slice(qualifier.start);
  }
  return definition.replace ? singleDefinition : singleDefinition.slice(0, definition.createEnd) + " OR REPLACE" + singleDefinition.slice(definition.createEnd);
}

export function prepareDisabledOracleTriggerReplacement(source: string, expected: TriggerReplacementIdentity): string {
  const sql = prepareOracleTriggerReplacement(source, expected);
  const tokens = scan(sql);
  const { state, insertion } = triggerHeaderBoundary(tokens, parseOracleTriggerDefinition(sql).tableEnd);
  if (state) return sql.slice(0, state.start) + "DISABLE" + sql.slice(state.end);
  return sql.slice(0, insertion) + "DISABLE\n" + sql.slice(insertion);
}
