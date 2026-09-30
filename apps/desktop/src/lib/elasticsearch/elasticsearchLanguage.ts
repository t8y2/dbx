import { jsonLanguage } from "@codemirror/lang-json";
import { defineLanguageFacet, Language, languageDataProp, LanguageSupport } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { NodeType, Parser, parseMixed, Tree, type Input, type PartialParse, type TreeFragment } from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";
import { elasticsearchRestRequestRanges } from "@/lib/sql/sqlStatementRanges";

const languageData = defineLanguageFacet();
const documentType = NodeType.define({ id: 0, name: "RestDocument", top: true, props: [[languageDataProp, languageData]] });
const methodType = NodeType.define({ id: 1, name: "RequestMethod", props: [styleTags({ RequestMethod: tags.keyword })] });
const bodyType = NodeType.define({ id: 2, name: "JsonBody" });
const commentType = NodeType.define({ id: 3, name: "RestComment", props: [styleTags({ RestComment: tags.comment })] });

interface BodyRange {
  from: number;
  to: number;
}

/** Use the same request boundaries as execution, including incomplete JSON bodies. */
export function elasticsearchJsonBodyRanges(text: string): BodyRange[] {
  return elasticsearchRestRequestRanges(text, "elasticsearch").flatMap((request) => {
    const header = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)\s*/i.exec(request.sql);
    if (!header) return [];
    const from = request.from + header[0].length;
    if (from >= request.to) return [];
    // Bulk and multi-search endpoints contain one independent JSON value per line.
    if (/\/(?:_bulk|_msearch)(?:\/template)?(?:\?|$)/.test(header[2])) {
      const ranges: BodyRange[] = [];
      let offset = from;
      for (const line of text.slice(from, request.to).split("\n")) {
        if (line.trim()) ranges.push({ from: offset, to: offset + line.trimEnd().length });
        offset += line.length + 1;
      }
      return ranges;
    }
    return [{ from, to: request.to }];
  });
}

class ElasticsearchRestParser extends Parser {
  constructor(private readonly sqlParser: Parser) {
    super();
  }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly BodyRange[]): PartialParse {
    const start = ranges[0].from;
    const end = ranges[ranges.length - 1].to;
    const text = input.read(start, end);
    const requests = elasticsearchRestRequestRanges(text, "elasticsearch");
    // Elasticsearch also accepts SQL. Keep its existing grammar outside REST documents.
    if (!requests.length) return this.sqlParser.startParse(input, fragments, ranges);
    const children: Tree[] = [];
    const positions: number[] = [];
    const nodes = [...requests.map((request) => ({ from: request.from, to: request.from + /^\S+/.exec(request.sql)![0].length, type: methodType })), ...elasticsearchJsonBodyRanges(text).map((body) => ({ ...body, type: bodyType }))];
    let preambleStart = 0;
    for (const request of requests) {
      for (const match of text.slice(preambleStart, request.from).matchAll(/#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
        const from = preambleStart + match.index;
        nodes.push({ from, to: from + match[0].length, type: commentType });
      }
      preambleStart = request.to;
    }
    nodes.sort((a, b) => a.from - b.from);
    let stoppedAt: number | null = null;
    const skeleton: PartialParse = {
      get parsedPos() {
        return stoppedAt ?? end;
      },
      get stoppedAt() {
        return stoppedAt;
      },
      stopAt(pos) {
        stoppedAt = pos;
      },
      advance() {
        const length = (stoppedAt ?? end) - start;
        for (const node of nodes) {
          if (node.from >= length) break;
          children.push(new Tree(node.type, [], [], Math.min(node.to, length) - node.from));
          positions.push(node.from);
        }
        return new Tree(documentType, children, positions, length);
      },
    };
    return parseMixed((node) => (node.type === bodyType ? { parser: jsonLanguage.parser } : null))(skeleton, input, fragments, ranges);
  }
}

export function elasticsearchJsonDiagnostics(state: EditorState): Diagnostic[] {
  const text = state.doc.toString();
  const diagnostics: Diagnostic[] = [];
  for (const range of elasticsearchJsonBodyRanges(text)) {
    const body = text.slice(range.from, range.to);
    try {
      JSON.parse(body);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      let from = range.from;
      let found = false;
      jsonLanguage.parser.parse(body).iterate({
        enter(node) {
          if (!found && node.type.isError) {
            from += node.from;
            found = true;
          }
        },
      });
      diagnostics.push({ from, to: Math.min(from + 1, range.to), severity: "error", message: error.message });
    }
  }
  return diagnostics;
}

export function elasticsearchLanguage(sqlParser: Parser, diagnosticsEnabled: () => boolean = () => true): LanguageSupport {
  return new LanguageSupport(
    new Language(languageData, new ElasticsearchRestParser(sqlParser), [], "elasticsearch"),
    linter((view) => (diagnosticsEnabled() ? elasticsearchJsonDiagnostics(view.state) : [])),
  );
}
