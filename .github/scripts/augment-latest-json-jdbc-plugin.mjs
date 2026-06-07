import { readFileSync, writeFileSync } from "node:fs";

export function augmentLatestJsonWithJdbcPlugin({ latestJson, jdbcVersion, protocolVersion, url }) {
  const data = JSON.parse(latestJson);
  data.jdbc_plugin = {
    version: jdbcVersion,
    protocol_version: Number(protocolVersion),
    url,
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

function main() {
  const [latestJsonPath, jdbcVersion, protocolVersion, url] = process.argv.slice(2);
  if (!latestJsonPath || !jdbcVersion || !protocolVersion || !url) {
    console.error("Usage: augment-latest-json-jdbc-plugin.mjs <latest.json> <jdbc-version> <protocol-version> <url>");
    process.exit(1);
  }

  const updated = augmentLatestJsonWithJdbcPlugin({
    latestJson: readFileSync(latestJsonPath, "utf8"),
    jdbcVersion,
    protocolVersion,
    url,
  });
  writeFileSync(latestJsonPath, updated);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
