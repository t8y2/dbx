import type { MongoPipeline } from "./mongoAggregation";

interface Token {
  text: string;
  kind: "word" | "string" | "number" | "symbol";
  quoted?: boolean;
}
interface Selection {
  field?: string;
  aggregate?: string;
  alias: string;
  star?: boolean;
}
export interface MongoSqlQuery {
  collection: string;
  pipeline: MongoPipeline;
}
const reserved = new Set(["WHERE", "INNER", "LEFT", "JOIN", "ON", "GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING", "UNION", "RIGHT", "FULL", "CROSS"]);
const keywords = new Set([...reserved, "SELECT", "FROM", "DISTINCT", "ALL", "AS", "BY", "AND", "OR", "NOT", "IN", "IS", "NULL", "TRUE", "FALSE", "ASC", "DESC", "OUTER"]);
function tokenize(sql: string): Token[] {
  if (sql.length > 100000) throw new Error("SQL exceeds 100,000 characters");
  const result: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const space = /^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (space) {
      index += space[0].length;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"' || quote === "`") {
      let value = "";
      let closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            value += quote;
            index += 2;
          } else {
            index++;
            closed = true;
            break;
          }
        } else value += sql[index++];
      }
      if (!closed) throw new Error("Unterminated SQL literal or identifier");
      result.push({ text: value, kind: quote === "'" ? "string" : "word", quoted: true });
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      result.push({ text: number[0], kind: "number" });
      index += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest);
    if (word) {
      result.push({ text: word[0], kind: "word" });
      index += word[0].length;
      continue;
    }
    const symbol = /^(?:>=|<=|<>|!=|[=><(),.*;])/.exec(rest);
    if (!symbol) throw new Error("Unsupported SQL token at character " + (index + 1));
    result.push({ text: symbol[0], kind: "symbol" });
    index += symbol[0].length;
  }
  return result;
}
const literal = (value: unknown) => ({ $literal: value });
const nonNull = (value: unknown) => ({ $ne: [{ $ifNull: [value, null] }, null] });

/** A fail-closed SELECT compiler. No source text is executed as JavaScript. */
export function compileMongoSql(sql: string): MongoSqlQuery {
  const tokens = tokenize(sql);
  let position = 0;
  const peek = () => tokens[position];
  const is = (text: string) => !peek()?.quoted && peek()?.text.toUpperCase() === text;
  const take = (text: string) => {
    if (is(text)) {
      position++;
      return true;
    }
    return false;
  };
  const expect = (text: string) => {
    if (!take(text)) throw new Error("Expected " + text + " near token " + (position + 1));
  };
  const identifier = () => {
    const token = tokens[position++];
    if (!token || token.kind !== "word" || !token.text || (!token.quoted && keywords.has(token.text.toUpperCase())) || token.text.startsWith("$") || token.text.includes("\0") || ["__proto__", "prototype", "constructor"].includes(token.text))
      throw new Error("Expected a safe identifier; quote reserved words");
    return token.text;
  };
  const field = () => {
    const parts = [identifier()];
    while (take(".")) parts.push(identifier());
    if (parts.some((part) => part.includes("."))) throw new Error("Literal field names containing dots are not supported by Mongo SQL");
    return parts.join(".");
  };
  const alias = (fallback: string) => {
    const value = take("AS") ? identifier() : peek()?.kind === "word" && !reserved.has(peek()!.text.toUpperCase()) && !is("FROM") && !is("ASC") && !is("DESC") ? identifier() : fallback;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value === "__proto__") throw new Error("Output aliases must be simple identifiers; use AS");
    return value;
  };
  expect("SELECT");
  const selections: Selection[] = [];
  do {
    if (take("*")) selections.push({ star: true, alias: "*" });
    else if (peek()?.kind === "word" && ["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(peek()!.text.toUpperCase()) && tokens[position + 1]?.text === "(") {
      const aggregate = identifier().toUpperCase();
      expect("(");
      const star = take("*");
      const selectedField = star ? undefined : field();
      expect(")");
      if (star && aggregate !== "COUNT") throw new Error("Only COUNT accepts *");
      selections.push({ aggregate, field: selectedField, alias: alias(aggregate.toLowerCase()) });
    } else {
      const selectedField = field();
      selections.push({ field: selectedField, alias: alias(selectedField.split(".").slice(-1)[0]) });
    }
  } while (take(","));
  expect("FROM");
  const collection = identifier();
  const sourceAlias = take("AS") ? identifier() : peek()?.kind === "word" && !reserved.has(peek()!.text.toUpperCase()) ? identifier() : collection;
  const pipeline: MongoPipeline = [];
  const joins = new Map<string, string>();
  const joining = is("JOIN") || is("INNER") || is("LEFT");
  if (joining) pipeline.push({ $replaceRoot: { newRoot: { __dbx_source: "$$ROOT" } } });
  const resolve = (name: string): string => {
    if (name.startsWith(sourceAlias + ".")) return (joining ? "$__dbx_source." : "$") + name.slice(sourceAlias.length + 1);
    const qualifier = name.split(".")[0];
    if (joins.has(qualifier)) return "$" + joins.get(qualifier) + name.slice(qualifier.length);
    if (joining) throw new Error("Qualify fields with collection aliases when using JOIN");
    return "$" + name;
  };
  while (is("JOIN") || is("INNER") || is("LEFT")) {
    const left = take("LEFT");
    if (left) take("OUTER");
    else take("INNER");
    expect("JOIN");
    const joinedCollection = identifier();
    const joinedAlias = take("AS") ? identifier() : !is("ON") ? identifier() : joinedCollection;
    if (joinedAlias === sourceAlias || joins.has(joinedAlias)) throw new Error("Duplicate JOIN alias");
    expect("ON");
    const lhs = field();
    expect("=");
    const rhs = field();
    const foreignPrefix = joinedAlias + ".";
    const foreign = lhs.startsWith(foreignPrefix) ? lhs : rhs.startsWith(foreignPrefix) ? rhs : "";
    const local = foreign === lhs ? rhs : lhs;
    if (!foreign || local.startsWith(foreignPrefix)) throw new Error("JOIN requires equality between source and joined fields");
    const localPath = resolve(local);
    const internal = "__dbx_join_" + joins.size;
    const foreignPath = "$" + foreign.slice(foreignPrefix.length);
    pipeline.push({
      $lookup: {
        from: joinedCollection,
        let: { local: localPath },
        pipeline: [{ $match: { $expr: { $and: [nonNull("$$local"), nonNull(foreignPath), { $eq: [foreignPath, "$$local"] }] } } }],
        as: internal,
      },
    });
    pipeline.push({ $unwind: { path: "$" + internal, preserveNullAndEmptyArrays: left } });
    joins.set(joinedAlias, internal);
  }
  function operand(): unknown {
    const token = peek();
    if (!token) throw new Error("Missing WHERE operand");
    if (token.kind === "string") {
      position++;
      return literal(token.text);
    }
    if (token.kind === "number") {
      position++;
      const value = Number(token.text);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Numeric literal exceeds JavaScript safe precision");
      return literal(value);
    }
    if (take("NULL")) return literal(null);
    if (take("TRUE")) return literal(true);
    if (take("FALSE")) return literal(false);
    return resolve(field());
  }
  let depth = 0;
  function predicate(): unknown {
    if (++depth > 32) throw new Error("WHERE nesting exceeds 32");
    try {
      if (take("(")) {
        const value = disjunction();
        expect(")");
        return value;
      }
      const lhs = operand();
      if (take("IS")) {
        const not = take("NOT");
        expect("NULL");
        return { [not ? "$ne" : "$eq"]: [{ $ifNull: [lhs, null] }, null] };
      }
      if (take("IN")) {
        expect("(");
        const values: unknown[] = [];
        do {
          values.push(operand());
        } while (take(","));
        expect(")");
        return { $and: [nonNull(lhs), { $in: [lhs, values] }] };
      }
      const operator = tokens[position++]?.text;
      const mapped = ({ "=": "$eq", "!=": "$ne", "<>": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" } as Record<string, string>)[operator ?? ""];
      if (!mapped) throw new Error("Supported WHERE operators: = != <> > >= < <= IN IS NULL AND OR");
      const rhs = operand();
      return { $and: [nonNull(lhs), nonNull(rhs), { [mapped]: [lhs, rhs] }] };
    } finally {
      depth--;
    }
  }
  function conjunction(): unknown {
    const items = [predicate()];
    while (take("AND")) items.push(predicate());
    return items.length === 1 ? items[0] : { $and: items };
  }
  function disjunction(): unknown {
    const items = [conjunction()];
    while (take("OR")) items.push(conjunction());
    return items.length === 1 ? items[0] : { $or: items };
  }
  if (take("WHERE")) pipeline.push({ $match: { $expr: disjunction() } });
  const groupFields: string[] = [];
  if (take("GROUP")) {
    expect("BY");
    do {
      groupFields.push(field());
    } while (take(","));
  }
  const grouping = groupFields.length > 0 || selections.some((item) => item.aggregate);
  const star = selections.some((item) => item.star);
  if (star && (grouping || joins.size || selections.length !== 1)) throw new Error("SELECT * must be a single ungrouped collection query without JOIN");
  if (new Set(selections.map((item) => item.alias)).size !== selections.length) throw new Error("Output aliases must be unique");
  const project: Record<string, unknown> = { _id: 0 };
  if (grouping) {
    const group: Record<string, unknown> = { _id: groupFields.length ? Object.fromEntries(groupFields.map((name, i) => ["g" + i, { $ifNull: [resolve(name), null] }])) : null };
    selections.forEach((item, i) => {
      if (item.aggregate) {
        const name = "a" + i;
        group[name] = item.aggregate === "COUNT" ? { $sum: item.field ? { $cond: [nonNull(resolve(item.field)), 1, 0] } : 1 } : { ["$" + item.aggregate.toLowerCase()]: resolve(item.field!) };
        if (item.aggregate === "SUM") {
          group["n" + i] = { $sum: { $cond: [nonNull(resolve(item.field!)), 1, 0] } };
          project[item.alias] = { $cond: [{ $gt: ["$n" + i, 0] }, "$" + name, null] };
        } else project[item.alias] = "$" + name;
      } else {
        const index = groupFields.findIndex((name) => resolve(name) === resolve(item.field!));
        if (index < 0) throw new Error("Every selected non-aggregate field must appear in GROUP BY");
        project[item.alias] = "$_id.g" + index;
      }
    });
    if (groupFields.length) pipeline.push({ $group: group });
    else {
      pipeline.push({ $facet: { aggregate: [{ $group: group }] } });
      const defaults = Object.fromEntries(
        selections.flatMap((item, i) => [
          ["a" + i, item.aggregate === "COUNT" ? 0 : null],
          ["n" + i, 0],
        ]),
      );
      pipeline.push({ $replaceRoot: { newRoot: { $ifNull: [{ $arrayElemAt: ["$aggregate", 0] }, { $literal: defaults }] } } });
    }
  } else if (!star)
    selections.forEach((item) => {
      project[item.alias] = { $ifNull: [resolve(item.field!), null] };
    });
  if (!star) pipeline.push({ $project: project });
  if (take("ORDER")) {
    expect("BY");
    const sort: Record<string, number> = {};
    do {
      const name = field();
      const output = star ? resolve(name).slice(1) : selections.find((item) => item.alias === name || item.field === name)?.alias;
      if (!output) throw new Error("ORDER BY must reference a selected field or alias");
      const descending = take("DESC");
      if (!descending) take("ASC");
      sort[output] = descending ? -1 : 1;
    } while (take(","));
    pipeline.push({ $sort: sort });
  }
  const integer = () => {
    const token = tokens[position++];
    const value = Number(token?.text);
    if (token?.kind !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("LIMIT/OFFSET requires a nonnegative safe integer");
    return value;
  };
  let limit: number | undefined;
  if (take("LIMIT")) limit = integer();
  if (take("OFFSET")) pipeline.push({ $skip: integer() });
  if (limit !== undefined) pipeline.push(limit === 0 ? { $match: { $expr: false } } : { $limit: limit });
  take(";");
  if (position !== tokens.length) throw new Error("Unsupported clause or additional statement near " + peek()!.text);
  return { collection, pipeline };
}
