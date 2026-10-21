type Token = {
  kind: "identifier" | "string" | "punctuation";
  text: string;
  value: string;
  start: number;
  end: number;
  quoted?: boolean;
};

function tokens(source: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < source.length;) {
    const start = index;
    const char = source[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (source.startsWith("--", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) throw new Error("Package source contains an unterminated comment.");
      index = close + 2;
      continue;
    }
    if ((char === "q" || char === "Q") && source[index + 1] === "'") {
      const opener = source[index + 2];
      if (!opener) throw new Error("Package source contains an invalid quoted string.");
      const closer = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[opener] || opener;
      const close = source.indexOf(`${closer}'`, index + 3);
      if (close < 0) throw new Error("Package source contains an unterminated quoted string.");
      index = close + 2;
      result.push({ kind: "string", text: source.slice(start, index), value: source.slice(start + 3, close), start, end: index });
      continue;
    }
    if (char === "'") {
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (source[index] === "'") {
          index++;
          closed = true;
          break;
        } else value += source[index++];
      }
      if (!closed) throw new Error("Package source contains an unterminated string.");
      result.push({ kind: "string", text: source.slice(start, index), value, start, end: index });
      continue;
    }
    if (char === '"') {
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (source[index] === '"') {
          index++;
          closed = true;
          break;
        } else value += source[index++];
      }
      if (!closed) throw new Error("Package source contains an unterminated quoted identifier.");
      result.push({ kind: "identifier", text: source.slice(start, index), value, quoted: true, start, end: index });
      continue;
    }
    if (/[A-Za-z_$#]/.test(char)) {
      index++;
      while (index < source.length && /[A-Za-z0-9_$#]/.test(source[index]!)) index++;
      const text = source.slice(start, index);
      result.push({ kind: "identifier", text, value: text.toUpperCase(), start, end: index });
      continue;
    }
    index++;
    result.push({ kind: "punctuation", text: char, value: char, start, end: index });
  }
  return result;
}

function matches(token: Token | undefined, name: string): boolean {
  if (!token || token.kind !== "identifier") return false;
  return token.value === name;
}

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Add CREATE to complete ALL_SOURCE text and retarget the package declaration,
 * its outer END name, and statically recognizable references to its own members.
 * Strings and comments are preserved byte-for-byte. Ambiguous shadowing is rejected.
 */
export function rewriteOraclePackageSource(source: string, options: { owner: string; oldName: string; newName: string; body: boolean }): string {
  const sourceTokens = tokens(source);
  const sourceWithTerminator = sourceTokens[sourceTokens.length - 1]?.text === ";" ? source : `${source};`;
  const list = tokens(sourceWithTerminator);
  const packageIndex = list.findIndex((token) => matches(token, "PACKAGE"));
  if (packageIndex < 0) throw new Error("Package source has no PACKAGE declaration.");
  if (packageIndex !== 0) throw new Error("Package source must contain exactly one package declaration and no preceding SQL.");
  const body = matches(list[packageIndex + 1], "BODY");
  if (body !== options.body) throw new Error("Package source type does not match the selected specification or body.");
  const sameName = (token: Token | undefined) => token?.kind === "identifier" && token.value === options.oldName;
  let nameIndex = packageIndex + (body ? 2 : 1);
  if (list[nameIndex + 1]?.text === ".") {
    if (!matches(list[nameIndex], options.owner)) throw new Error("Package source owner does not match the selected owner.");
    nameIndex += 2;
  }
  if (!sameName(list[nameIndex])) throw new Error("Package declaration does not match the selected object.");

  const declarations = new Set([packageIndex, nameIndex]);
  const edits: Array<{ start: number; end: number; value: string }> = [
    { start: list[packageIndex]!.start, end: list[packageIndex]!.start, value: "CREATE " },
    { start: list[nameIndex]!.start, end: list[nameIndex]!.end, value: quotedIdentifier(options.newName) },
  ];

  // Only the final END can name the package; nested routine and block ENDs are untouched.
  const last = list[list.length - 1];
  if (last?.text !== ";") throw new Error("Package source does not end with a complete semicolon.");
  const outerEnd = list[list.length - 2];
  const preceding = list[list.length - 3];
  if (outerEnd && preceding && matches(preceding, "END") && sameName(outerEnd)) {
    declarations.add(list.length - 2);
    edits.push({ start: outerEnd.start, end: outerEnd.end, value: quotedIdentifier(options.newName) });
  } else if (outerEnd && matches(outerEnd, "END")) {
    // An unnamed outer END is valid and needs no change.
  } else {
    throw new Error("Package source has no verifiable outer END.");
  }

  if (options.body) {
    const declarationStarts = list.flatMap((token, index) => (index > packageIndex && (matches(token, "AS") || matches(token, "IS")) ? [index] : []));
    for (const declarationStart of declarationStarts) {
      const bodyStart = list.findIndex((token, index) => index > declarationStart && matches(token, "BEGIN"));
      if (bodyStart > declarationStart && list.slice(declarationStart + 1, bodyStart).some((token) => token.kind === "identifier" && token.value === options.newName)) {
        throw new Error(`Package body declares ${options.newName}, which could capture a reference after Save As.`);
      }
      let close = -1;
      for (let index = declarationStart - 1; index >= 0; index--) {
        if (list[index]!.text === ")") {
          close = index;
          break;
        }
      }
      if (close >= 0) {
        let nesting = 0;
        let open = -1;
        for (let index = close; index >= 0; index--) {
          if (list[index]!.text === ")") nesting++;
          else if (list[index]!.text === "(" && --nesting === 0) {
            open = index;
            break;
          }
        }
        if (open >= 0 && list.slice(open + 1, close).some((token) => token.kind === "identifier" && token.value === options.newName)) {
          throw new Error(`Package body parameter ${options.newName} could capture a reference after Save As.`);
        }
      }
    }
    for (let declarationStart = 0; declarationStart < list.length; declarationStart++) {
      if (!matches(list[declarationStart], "DECLARE")) continue;
      const bodyStart = list.findIndex((token, index) => index > declarationStart && matches(token, "BEGIN"));
      if (bodyStart > declarationStart && list.slice(declarationStart + 1, bodyStart).some((token) => token.kind === "identifier" && token.value === options.newName)) {
        throw new Error(`Package body declares ${options.newName}, which could capture a reference after Save As.`);
      }
    }
  }

  for (let index = 0; index < list.length; index++) {
    const token = list[index]!;
    const referencedPackage = sameName(token);
    if (declarations.has(index) || !referencedPackage) continue;
    const next = list[index + 1];
    if (next?.text !== ".") {
      // A bare occurrence may be a local variable/member. It is only safe when it
      // is one of the declaration or outer-END names handled above.
      throw new Error(`Package source contains an ambiguous unqualified reference to ${options.oldName}.`);
    }
    if (list[index - 1]?.text === ".") {
      if (matches(list[index - 2], options.owner)) {
        edits.push({ start: token.start, end: token.end, value: quotedIdentifier(options.newName) });
      }
      continue;
    }
    edits.push({ start: token.start, end: token.end, value: quotedIdentifier(options.newName) });
  }

  // Dynamic SQL is safe to copy only when its complete statement text is a literal.
  for (let index = 0; index < list.length; index++) {
    if (!matches(list[index], "EXECUTE") || !matches(list[index + 1], "IMMEDIATE")) continue;
    const token = list[index + 2];
    if (token?.kind !== "string") throw new Error("Dynamic SQL must use a complete string literal; replace the expression with corrected source before Save As.");
    const clause = list[index + 3];
    if (clause && clause.text !== ";" && !(clause.kind === "identifier" && ["INTO", "USING", "RETURNING"].includes(clause.value))) {
      throw new Error("Dynamic SQL must use a complete string literal; replace the expression with corrected source before Save As.");
    }
    const dynamicTokens = tokens(token.value);
    for (let dynamicIndex = 0; dynamicIndex < dynamicTokens.length; dynamicIndex++) {
      if (matches(dynamicTokens[dynamicIndex], "EXECUTE") && matches(dynamicTokens[dynamicIndex + 1], "IMMEDIATE")) {
        throw new Error("Nested dynamic SQL cannot be safely retargeted; replace the expression with a corrected static or single-level statement before Save As.");
      }
      if (sameName(dynamicTokens[dynamicIndex]) && dynamicTokens[dynamicIndex + 1]?.text === ".") {
        throw new Error("Package source contains a dynamic string reference that cannot be safely retargeted.");
      }
    }
  }

  edits.sort((left, right) => right.start - left.start);
  let rewritten = sourceWithTerminator;
  let previousStart = sourceWithTerminator.length + 1;
  for (const edit of edits) {
    if (edit.end > previousStart) throw new Error("Package source contains overlapping rename edits.");
    rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end);
    previousStart = edit.start;
  }
  return rewritten;
}

export function oraclePackageCatalogSource(createSql: string): string {
  const list = tokens(createSql);
  const packageIndex = list.findIndex((token) => matches(token, "PACKAGE"));
  const create = list[packageIndex - 1];
  if (packageIndex < 0) throw new Error("Package source has no PACKAGE declaration.");
  const packageSource = matches(create, "CREATE") ? createSql.slice(0, create.start) + createSql.slice(list[packageIndex]!.start) : createSql;
  const sourceTokens = tokens(packageSource);
  const terminator = sourceTokens[sourceTokens.length - 1];
  return (terminator?.text === ";" ? packageSource.slice(0, terminator.start) : packageSource).trimEnd();
}
