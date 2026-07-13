import { classifySqlStatementRisk, splitSqlStatementsForSafety, sqlSafetyText } from "./sql-risk.js";

export interface SqlSafetyOptions {
  allowWrites?: boolean;
  allowDangerous?: boolean;
  allowMultipleStatements?: boolean;
}

export interface SqlSafetyDecision {
  allowed: boolean;
  reason?: string;
}

const DANGEROUS_RISKS = new Set(["ddl", "transaction", "unknown"]);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return undefined;
}

export function evaluateSqlSafety(sql: string, options: SqlSafetyOptions = {}): SqlSafetyDecision {
  const statements = splitSqlStatementsForSafety(sql);
  if (statements.length === 0) return { allowed: false, reason: "SQL is empty." };
  if (statements.length > 1 && !options.allowMultipleStatements) {
    return { allowed: false, reason: "Only one SQL statement is allowed per query." };
  }

  for (let i = 0; i < statements.length; i++) {
    const decision = evaluateSingleSqlStatementSafety(statements[i], options);
    if (!decision.allowed && statements.length > 1) {
      return {
        allowed: false,
        reason: `Statement ${i + 1}: ${decision.reason ?? "SQL blocked."}`,
      };
    }
    if (!decision.allowed) return decision;
  }

  return { allowed: true };
}

function evaluateSingleSqlStatementSafety(sql: string, options: SqlSafetyOptions = {}): SqlSafetyDecision {
  const assessment = classifySqlStatementRisk(sql);
  const firstKeyword = assessment.firstKeyword;
  if (!firstKeyword) return { allowed: false, reason: "SQL statement is not recognized." };

  if (DANGEROUS_RISKS.has(assessment.risk) && !options.allowDangerous) {
    return { allowed: false, reason: `Dangerous SQL or unrecognized SQL statement "${firstKeyword.toUpperCase()}" is blocked.` };
  }

  if (!options.allowWrites && assessment.risk !== "read") {
    return {
      allowed: false,
      reason: "MCP SQL execution is read-only for this session. Set DBX_MCP_ALLOW_WRITES=1 to allow write statements.",
    };
  }

  if (options.allowWrites && !options.allowDangerous) {
    const tokens: string[] = sqlSafetyText(sql).toLowerCase().match(/[a-z_]+/g) ?? [];
    if (firstKeyword === "update" && !tokens.includes("where")) {
      return { allowed: false, reason: "UPDATE statements must include a WHERE clause." };
    }
    if (firstKeyword === "delete" && !tokens.includes("where")) {
      return { allowed: false, reason: "DELETE statements must include a WHERE clause." };
    }
  }

  return { allowed: true };
}

export function sqlSafetyFromEnv(env: NodeJS.ProcessEnv = process.env): SqlSafetyOptions {
  const allowWrites = parseBooleanEnv(env.DBX_MCP_ALLOW_WRITES);
  const allowDangerous = parseBooleanEnv(env.DBX_MCP_ALLOW_DANGEROUS_SQL);
  return {
    allowWrites: allowWrites ?? true,
    allowDangerous: allowDangerous ?? false,
  };
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let statementStart = 0;
  let index = 0;
  let state: "none" | "single" | "double" | "backtick" | "bracket" | "lineComment" | "blockComment" | "dollar" = "none";
  let dollarTag = "";

  const pushStatement = (end: number) => {
    const statement = sql.slice(statementStart, end).trim();
    if (statement) statements.push(statement);
  };

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (state === "lineComment") {
      if (char === "\n" || char === "\r") state = "none";
      index += 1;
      continue;
    }
    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        state = "none";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "none";
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "backtick") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        state = "none";
      } else if (char === "\\" && next) {
        // Preserve dialects that accept backslash escapes without letting an escaped quote end the literal.
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "bracket") {
      if (char === "]") {
        if (next === "]") {
          index += 2;
          continue;
        }
        state = "none";
      }
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      state = "lineComment";
      index += 2;
      continue;
    }
    if (char === "#") {
      state = "lineComment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "blockComment";
      index += 2;
      continue;
    }
    if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "backtick";
    else if (char === "[") state = "bracket";
    else if (char === "$") {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        index += dollarTag.length;
        continue;
      }
    } else if (char === ";") {
      pushStatement(index);
      statementStart = index + 1;
    }
    index += 1;
  }

  pushStatement(sql.length);
  return statements;
}
