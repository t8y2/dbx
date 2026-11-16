import { NodeType, Parser, parseMixed, Tree, type Input, type PartialParse, type TreeFragment } from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";
import type { SQLDialect } from "@codemirror/lang-sql";
import { readSqlBracedParameterAt, sqlParameterAnalysisRanges, type SqlParameterOptions } from "@/lib/sql/sqlParameters";

const documentType = NodeType.define({ id: 0, name: "SqlParameterLine", top: true });
const parameterType = NodeType.define({ id: 1, name: "SqlParameter", props: [styleTags({ SqlParameter: tags.variableName })] });
const bodyType = NodeType.define({ id: 2, name: "SqlParameterLineBody" });

/** Reparse only hash-comment tokens that execution recognizes as MyBatis parameters. */
class SqlParameterLineParser extends Parser {
  constructor(
    private readonly sqlParser: Parser,
    private readonly options?: SqlParameterOptions,
  ) {
    super();
  }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const start = ranges[0].from;
    const end = ranges[ranges.length - 1].to;
    const parameters = sqlParameterAnalysisRanges(input.read(start, end), this.options);
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
        const children: Tree[] = [];
        const positions: number[] = [];
        let from = 0;
        for (const parameter of parameters) {
          if (parameter.from >= length) break;
          if (parameter.from > from) {
            children.push(new Tree(bodyType, [], [], parameter.from - from));
            positions.push(from);
          }
          children.push(new Tree(parameterType, [], [], Math.min(parameter.to, length) - parameter.from));
          positions.push(parameter.from);
          from = parameter.to;
        }
        if (from < length) {
          children.push(new Tree(bodyType, [], [], length - from));
          positions.push(from);
        }
        return new Tree(documentType, children, positions, length);
      },
    };
    return parseMixed((node) => (node.type === bodyType ? { parser: this.sqlParser } : null))(skeleton, input, fragments, ranges);
  }
}

export function withSqlParameterHighlighting(dialect: SQLDialect, options?: SqlParameterOptions): SQLDialect {
  if (!dialect.spec.hashComments || (options?.enabledSyntaxes && !options.enabledSyntaxes.includes("mybatis"))) return dialect;
  const parser = new SqlParameterLineParser(dialect.language.parser, options);
  return dialect.configureLanguage({
    wrap: parseMixed((node, input) => {
      if (node.type.name !== "LineComment" || input.read(node.from, Math.min(node.from + 2, node.to)) !== "#{") return null;
      if (readSqlBracedParameterAt(input.read(node.from, node.to), 0, options)?.syntax !== "mybatis") return null;
      return { parser };
    }),
  });
}
