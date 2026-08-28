import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(scriptDir, "../content/docs");
const repositoryDir = path.resolve(scriptDir, "../..");
const errors = [];

const files = fs
  .readdirSync(docsDir)
  .filter((file) => file.endsWith(".mdx"))
  .sort();

const pages = new Map();

for (const file of files) {
  const chinese = file.endsWith(".cn.mdx");
  const slug = file.replace(/\.cn\.mdx$|\.mdx$/, "");
  const page = pages.get(slug) ?? {};
  page[chinese ? "cn" : "en"] = file;
  pages.set(slug, page);
}

for (const [slug, page] of pages) {
  if (!page.cn || !page.en) {
    errors.push(`${slug}: missing ${page.cn ? "English" : "Chinese"} page`);
  }
}

function navigationPages(file) {
  const navigation = JSON.parse(fs.readFileSync(path.join(docsDir, file), "utf8"));
  return navigation.pages.filter((entry) => !entry.startsWith("---"));
}

const chineseNavigation = navigationPages("meta.cn.json");
const englishNavigation = navigationPages("meta.json");

for (const [name, entries] of [
  ["meta.cn.json", chineseNavigation],
  ["meta.json", englishNavigation],
]) {
  const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
  for (const slug of new Set(duplicates)) errors.push(`${name}: duplicate page ${slug}`);

  for (const slug of entries) {
    if (!pages.has(slug)) errors.push(`${name}: unknown page ${slug}`);
  }

  for (const slug of pages.keys()) {
    if (!entries.includes(slug)) errors.push(`${name}: page ${slug} is not in navigation`);
  }
}

if (JSON.stringify(chineseNavigation) !== JSON.stringify(englishNavigation)) {
  errors.push("Chinese and English navigation page order differs");
}

const knownSlugs = new Set(pages.keys());

for (const file of files) {
  const fullPath = path.join(docsDir, file);
  const content = fs.readFileSync(fullPath, "utf8");
  const expectedLanguage = file.endsWith(".cn.mdx") ? "cn" : "en";
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);

  if (!frontmatter) {
    errors.push(`${file}: missing frontmatter`);
  } else {
    if (!/^title:\s*.+$/m.test(frontmatter[1])) errors.push(`${file}: missing title`);
    if (!/^description:\s*.+$/m.test(frontmatter[1])) errors.push(`${file}: missing description`);
  }

  const headings = [...content.matchAll(/^#{2,4}\s+(.+)$/gm)].map((match) => match[1].trim());
  const headingCounts = new Map();
  for (const heading of headings) headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1);
  for (const [heading, count] of headingCounts) {
    if (count > 1) errors.push(`${file}: duplicate heading "${heading}"`);
  }

  const links = [
    ...content.matchAll(/\]\(\/(cn|en)\/docs\/([^)#?]+)(?:#[^)]*)?\)/g),
    ...content.matchAll(/href="\/(cn|en)\/docs\/([^"#?]+)(?:#[^"]*)?"/g),
  ];

  for (const link of links) {
    const [, language, slug] = link;
    if (!knownSlugs.has(slug)) errors.push(`${file}: broken documentation link /${language}/docs/${slug}`);
    if (language !== expectedLanguage) errors.push(`${file}: cross-language documentation link /${language}/docs/${slug}`);
  }
}

const databaseSupportSource = fs.readFileSync(path.join(repositoryDir, "docs/data/databaseSupport.ts"), "utf8");
const connectionProfilesSource = fs.readFileSync(path.join(repositoryDir, "apps/desktop/src/types/generated/connectionProfiles.ts"), "utf8");
const jdbcProductProfilesSource = fs.readFileSync(path.join(repositoryDir, "apps/desktop/src/lib/database/jdbcProductProfiles.ts"), "utf8");
const connectionOptionsMatch = connectionProfilesSource.match(
  /export const CONNECTION_PICKER_OPTIONS = \[([\s\S]*?)\n\] as const satisfies readonly ConnectionPickerOption\[\];/,
);
const jdbcProductProfilesMatch = jdbcProductProfilesSource.match(/JDBC_PRODUCT_PROFILES = \[([^\]]*)\]/);

if (!connectionOptionsMatch) {
  errors.push("Unable to read database options from connectionProfiles.ts");
} else {
  const connectionModeIds = new Set(["custom_mysql", "custom_postgres"]);
  const connectionIds = [...connectionOptionsMatch[1].matchAll(/value: "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => !connectionModeIds.has(id));

  if (!jdbcProductProfilesMatch) {
    errors.push("Unable to read registered JDBC product profiles");
  } else {
    const profileNames = [...jdbcProductProfilesMatch[1].matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)].map((match) => match[1]);
    for (const profileName of profileNames) {
      const importPattern = new RegExp(`import \\{[^}]*\\b${profileName}\\b[^}]*\\} from "@/([^"]+)"`);
      const profileImport = jdbcProductProfilesSource.match(importPattern);
      if (!profileImport) {
        errors.push(`Unable to resolve JDBC product profile ${profileName}`);
        continue;
      }

      const profileSource = fs.readFileSync(path.join(repositoryDir, "apps/desktop/src", `${profileImport[1]}.ts`), "utf8");
      const profileBody = profileSource.match(new RegExp(`export const ${profileName}[^=]*= \\{([\\s\\S]*?)\\n\\};`));
      const idExpression = profileBody?.[1].match(/\bid:\s*([^,\n]+)/)?.[1].trim();
      const directId = idExpression?.match(/^"([^"]+)"$/)?.[1];
      const constantId = idExpression && !directId ? profileSource.match(new RegExp(`(?:export )?const ${idExpression} = "([^"]+)"`))?.[1] : undefined;
      const profileId = directId ?? constantId;
      if (profileId) connectionIds.push(profileId);
      else errors.push(`Unable to read database id for JDBC product profile ${profileName}`);
    }
  }

  const websiteIds = [...databaseSupportSource.matchAll(/\{ id: "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => id !== "request");

  for (const [label, ids] of [
    ["connectionProfiles.ts", connectionIds],
    ["databaseSupport.ts", websiteIds],
  ]) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    for (const id of new Set(duplicates)) errors.push(`${label}: duplicate database id ${id}`);
  }

  const connectionIdSet = new Set(connectionIds);
  const websiteIdSet = new Set(websiteIds);
  for (const id of connectionIds) {
    if (!websiteIdSet.has(id)) errors.push(`databaseSupport.ts: missing connection option ${id}`);
  }
  for (const id of websiteIds) {
    if (!connectionIdSet.has(id)) errors.push(`databaseSupport.ts: unknown connection option ${id}`);
  }
}

for (const match of databaseSupportSource.matchAll(/icon: "\/([^"?]+)"/g)) {
  if (!fs.existsSync(path.join(repositoryDir, "docs/public", match[1]))) {
    errors.push(`databaseSupport.ts: missing icon /${match[1]}`);
  }
}

if (errors.length > 0) {
  console.error("Documentation content verification failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Verified ${pages.size} bilingual documentation pages.`);
