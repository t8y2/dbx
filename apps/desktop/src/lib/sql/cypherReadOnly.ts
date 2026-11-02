const UNSAFE_WORDS = new Set(["CREATE", "INSERT", "MERGE", "SET", "REMOVE", "DELETE", "DETACH", "DROP", "ALTER", "RENAME", "GRANT", "REVOKE", "DENY", "CALL", "FOREACH", "LOAD", "START", "STOP", "TERMINATE"]);

// Keep parity with dbx-sql-core/cypher_read_only.rs. `--` must remain an edge.
export function isProvenReadOnlyCypher(source: string): boolean {
  // Neo4j expands Unicode escapes before lexing, including inside comments.
  if (source.includes("\\u")) return false;
  const statements: string[][] = [[]];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && !["\n", "\r"].includes(source[index])) index++;
    } else if (char === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          return false;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth !== 0) return false;
    } else if (char === "'" || char === '"' || char === "`") {
      index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === char) {
          index++;
          if (source[index] === char) index++;
          else {
            closed = true;
            break;
          }
        } else index++;
      }
      if (!closed) return false;
      statements[statements.length - 1].push("<quoted>");
    } else if (char === ";") {
      statements.push([]);
      index++;
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < source.length && /[\p{L}\p{N}_]/u.test(source[index])) index++;
      statements[statements.length - 1].push(source.slice(start, index).toUpperCase());
    } else {
      if ([".", ":", "$"].includes(char)) statements[statements.length - 1].push(char);
      else if (!/\s/u.test(char)) statements[statements.length - 1].push("<symbol>");
      index++;
    }
  }
  const nonempty = statements.filter((words) => words.length);
  return (
    nonempty.length > 0 &&
    nonempty.every(
      (words) => ["MATCH", "OPTIONAL", "RETURN", "WITH", "UNWIND", "SHOW", "EXPLAIN", "PROFILE"].includes(words[0]) && (words[0] === "SHOW" || words.includes("RETURN")) && !words.some((word, index) => UNSAFE_WORDS.has(word) && ![".", ":", "$"].includes(words[index - 1]) && words[index + 1] !== ":"),
    )
  );
}
