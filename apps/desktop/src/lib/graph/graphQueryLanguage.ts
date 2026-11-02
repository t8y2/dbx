import { StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { cypher } from "@codemirror/legacy-modes/mode/cypher";
import { graphFunctionDefinitions } from "./graphQueryFunctions";
import { graphQueryDatabases, graphQueryProfile } from "./graphQueryProfiles";
import type { GraphQueryDatabase } from "./graphQueryProfile";
export type { GraphQueryDatabase } from "./graphQueryProfile";
export { isGraphQueryDatabase } from "./graphQueryProfiles";

export function graphQueryKeywords(databaseType: GraphQueryDatabase): string[] {
  return [...graphQueryProfile(databaseType).keywords];
}

export function graphQueryFunctions(databaseType: GraphQueryDatabase): string[] {
  return graphFunctionDefinitions(databaseType).map((definition) => definition.name);
}

interface GraphStreamState {
  base: unknown;
  quote: string | null;
  commentDepth: number;
}

function graphQueryParser(databaseType: GraphQueryDatabase): StreamParser<GraphStreamState> {
  const keywords = new Set(graphQueryKeywords(databaseType));
  const functions = new Set(graphQueryFunctions(databaseType).map((name) => name.toLowerCase()));
  const readQuote = (stream: StringStream, state: GraphStreamState) => {
    const quote = state.quote;
    while (!stream.eol()) {
      const char = stream.next();
      if (char === "\\" && quote !== "`") stream.next();
      else if (char === quote && !stream.eat(quote)) {
        state.quote = null;
        break;
      }
    }
    return quote === "`" ? "variable" : "string";
  };
  const readComment = (stream: StringStream, state: GraphStreamState) => {
    while (!stream.eol() && state.commentDepth > 0) {
      if (stream.match("/*")) state.commentDepth++;
      else if (stream.match("*/")) state.commentDepth--;
      else stream.next();
    }
    return "comment";
  };
  return {
    name: databaseType === "neo4j" ? "cypher" : "ngql",
    startState: (indentUnit) => ({ base: cypher.startState?.(indentUnit), quote: null, commentDepth: 0 }),
    copyState: (state) => ({ ...state, base: cypher.copyState ? cypher.copyState(state.base) : { ...(state.base as object) } }),
    // Reuse CodeMirror's Cypher mode, adding nGQL vocabulary and complete literal/comment spans.
    token(stream, state) {
      if (state.commentDepth) return readComment(stream, state);
      if (state.quote) return readQuote(stream, state);
      if (stream.eatSpace()) return null;
      if (stream.match("//") || (databaseType === "nebula" && stream.eat("#"))) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("/*")) {
        state.commentDepth = 1;
        return readComment(stream, state);
      }
      if (stream.match(/^["'`]/)) {
        state.quote = stream.current();
        return readQuote(stream, state);
      }
      if (stream.match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)) {
        const word = stream.current();
        if (keywords.has(word.toUpperCase())) return "keyword";
        return functions.has(word.toLowerCase()) ? "builtin" : "variable";
      }
      if (stream.eat(":")) return "punctuation";
      return cypher.token(stream, state.base);
    },
    languageData: { commentTokens: { line: graphQueryProfile(databaseType).lineComment, block: { open: "/*", close: "*/" } } },
  };
}

const graphParsers = new Map(graphQueryDatabases.map((type) => [type, graphQueryParser(type)]));
const graphLanguages = new Map(graphQueryDatabases.map((type) => [type, StreamLanguage.define(graphParsers.get(type)!)]));

export function graphQueryLanguage(databaseType: GraphQueryDatabase) {
  return graphLanguages.get(databaseType)!;
}

export interface GraphQueryToken {
  text: string;
  from: number;
  to: number;
  kind: string | null;
  open: boolean;
}

export function graphQueryTokens(text: string, databaseType: GraphQueryDatabase): GraphQueryToken[] {
  const parser = graphParsers.get(databaseType)!;
  const state = parser.startState!(2);
  const tokens: GraphQueryToken[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const quote = state.quote ?? (/["'`]/.test(stream.peek() ?? "") ? stream.peek() : null);
      const kind = parser.token(stream, state);
      const value = stream.current();
      if (value.trim()) tokens.push({ text: value, from: offset + stream.start, to: offset + stream.pos, kind: quote === "`" ? "identifier" : kind, open: !!state.quote || state.commentDepth > 0 });
    }
    offset += line.length + 1;
  }
  return tokens;
}
