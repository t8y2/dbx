import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "docs/content/docs";
const DEFAULT_OUTPUT = "outputs/knowledge-base/DBX_knowledge_base_cn.md";
const DEFAULT_LANG = "cn";

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input ?? DEFAULT_INPUT);
  const outputFile = path.resolve(args.output ?? DEFAULT_OUTPUT);
  const lang = args.lang ?? DEFAULT_LANG;
  const fileSuffix = lang ? `.${lang}.mdx` : ".mdx";

  const files = (await fs.readdir(inputDir))
    .filter((name) => name.endsWith(fileSuffix))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No ${fileSuffix} files found in ${inputDir}`);
  }

  const documents = [];
  let entryCount = 0;

  for (const file of files) {
    const sourcePath = path.join(inputDir, file);
    const displayPath = path.relative(process.cwd(), sourcePath).replaceAll(path.sep, "/");
    const raw = await fs.readFile(sourcePath, "utf8");
    const { fields, body } = parseFrontmatter(raw);
    const title = fields.title || file.replace(/\.mdx$/, "");
    const description = fields.description || "";
    const sections = [];

    for (const section of splitSections(body)) {
      const clean = normalizeMdx(section.lines.join("\n"));
      if (!clean || clean.length < 20) continue;

      const chunks = chunkText(clean).map((chunk, index, all) => {
        const heading = all.length > 1 ? `${section.heading}（${index + 1}/${all.length}）` : section.heading;
        return {
          heading,
          question: questionFor(title, section.heading, chunk),
          keywords: keywordsFor(title, section.heading, description, chunk),
          answer: chunk,
        };
      });

      entryCount += chunks.length;
      sections.push(...chunks);
    }

    documents.push({ source: displayPath, title, description, sections });
  }

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, renderMarkdown(documents), "utf8");

  console.log(`Knowledge base written: ${path.relative(process.cwd(), outputFile)}`);
  console.log(`Sources: ${files.length}`);
  console.log(`Entries: ${entryCount}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/build-knowledge-base.mjs [options]

Options:
  --input <dir>      MDX docs directory. Default: ${DEFAULT_INPUT}
  --output <file>    Output Markdown path. Default: ${DEFAULT_OUTPUT}
  --lang <suffix>    File language suffix, e.g. cn for *.cn.mdx. Default: ${DEFAULT_LANG}
`);
}

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  if (!match) return { fields, body: source };

  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }

  return { fields, body: source.slice(match[0].length) };
}

function splitSections(body) {
  const sections = [];
  let current = { heading: "概览", lines: [] };

  for (const line of body.split("\n")) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading) {
      if (current.lines.join("\n").trim()) sections.push(current);
      current = { heading: heading[2].replace(/`/g, "").trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }

  if (current.lines.join("\n").trim()) sections.push(current);
  return sections;
}

function normalizeMdx(text) {
  return text
    .replace(/<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g, (_, attrs, inner) => {
      const title = attrs.match(/title=["']([^"']+)["']/)?.[1] ?? "";
      const href = attrs.match(/href=["']([^"']+)["']/)?.[1] ?? "";
      return [title && `**${title}**`, normalizeMdx(inner), href && `参考链接：${href}`].filter(Boolean).join("\n\n");
    })
    .replace(/<Callout[^>]*>([\s\S]*?)<\/Callout>/g, (_, inner) => normalizeMdx(inner))
    .replace(/<Tab[^>]*>([\s\S]*?)<\/Tab>/g, (_, inner) => normalizeMdx(inner))
    .replace(/<Step[^>]*>([\s\S]*?)<\/Step>/g, (_, inner) => normalizeMdx(inner))
    .replace(/<[^>\n]+>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/^\s{0,6}#{1,6}\s+(.+)$/gm, "$1")
    .replace(/^\s*import\s+.*$/gm, "")
    .replace(/^\s*export\s+.*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text, maxLength = 2200) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const next = [current, paragraph].filter(Boolean).join("\n\n");
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength) return [chunk];
    const pieces = [];
    for (let index = 0; index < chunk.length; index += maxLength) {
      pieces.push(chunk.slice(index, index + maxLength));
    }
    return pieces;
  });
}

function questionFor(category, heading, text) {
  if (heading === "概览") return `DBX 的${category}是什么？`;
  if (/安装|配置|导入|导出|创建|连接|使用流程|快速开始|启动|构建|下载|打开|执行|添加|删除|更新/.test(heading)) {
    return `DBX 中如何${heading.replace(/^(第一步|第二步|第三步|第四步|第五步)：/, "")}？`;
  }
  if (/常见|问题|故障|错误|诊断|冲突|无法/.test(heading) || /失败|报错|检查/.test(text)) {
    return `DBX ${heading}时应该检查什么？`;
  }
  if (/支持|覆盖|矩阵|类型|数据库|文件|供应商|快捷键|命令|端口/.test(heading)) {
    return `DBX ${heading}支持哪些内容？`;
  }
  return `DBX 的${heading}是什么？`;
}

function keywordsFor(category, heading, description, text) {
  const pool = `${category} ${heading} ${description} ${text}`;
  const candidates = [
    "DBX",
    "AI",
    "SQL",
    "MCP",
    "JDBC",
    "SSH",
    "Docker",
    "CLI",
    "MongoDB",
    "Redis",
    "MySQL",
    "PostgreSQL",
    "SQLite",
    "DuckDB",
    "ClickHouse",
    "Oracle",
    "SQL Server",
    "Schema",
    "ER",
    "导入",
    "导出",
    "连接",
    "表",
    "字段",
    "查询",
    "快捷键",
    "插件",
    "驱动",
    "配置",
    "安全",
    "数据传输",
    "格式化",
    "代码片段",
    "隧道",
    "生产环境",
  ];
  const found = candidates.filter((word) => pool.includes(word));
  return [...new Set([category, heading, ...found])].slice(0, 14).join(", ");
}

function renderMarkdown(documents) {
  const lines = [
    "# DBX 中文知识库",
    "",
    "> 从 `docs/content/docs/*.cn.mdx` 生成的纯 Markdown 知识库内容。",
    "",
    "## 来源索引",
    "",
    "| 来源文件 | 标题 | 描述 | 知识条数 |",
    "| --- | --- | --- | ---: |",
  ];

  for (const document of documents) {
    lines.push(
      `| ${escapeTableCell(document.source)} | ${escapeTableCell(document.title)} | ${escapeTableCell(document.description)} | ${document.sections.length} |`,
    );
  }

  for (const document of documents) {
    lines.push("", `## ${document.title}`, "");
    if (document.description) lines.push(document.description, "");
    lines.push(`来源：\`${document.source}\``, "");

    for (const section of document.sections) {
      lines.push(`### ${section.heading}`, "");
      lines.push(`问题：${section.question}`, "");
      lines.push(`关键词：${section.keywords}`, "");
      lines.push("答案：", "");
      lines.push(section.answer, "");
      lines.push("---", "");
    }
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}
