import { loader } from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement } from "react";
import { i18n } from "@/lib/i18n";
import { docs } from "@/.source/server";

const pageIcons: Record<string, keyof typeof icons> = {
  "what-is-dbx": "BookOpen",
  changelog: "History",
  "getting-started": "Rocket",
  databases: "Database",
  "query-editor": "SquareTerminal",
  "data-grid": "Table2",
  "schema-browser": "Network",
  redis: "KeyRound",
  mongodb: "Braces",
  "object-browser": "Package",
  "schema-diff": "GitCompareArrows",
  "data-transfer": "ArrowRightLeft",
  "table-structure": "TableProperties",
  "field-lineage": "GitBranch",
  "table-import": "Upload",
  "sql-file": "FileCode2",
  "database-export": "Download",
  "sql-snippets": "ScrollText",
  "ai-assistant": "Bot",
  cli: "Terminal",
  mcp: "Cable",
  plugins: "Plug",
  "driver-management": "Package",
  "keyboard-shortcuts": "Keyboard",
  "connection-import": "Import",
  "config-export": "FileUp",
  "ssh-tunnel": "ShieldCheck",
};

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  i18n,
  plugins: [
    {
      name: "dbx-sidebar-icons",
      transformPageTree: {
        file(node) {
          const slug = node.url.split("/").filter(Boolean).at(-1);
          const iconName = slug ? pageIcons[slug] : undefined;
          const Icon = iconName ? icons[iconName] : undefined;

          if (!Icon) return node;

          return {
            ...node,
            icon: createElement(Icon, {
              "aria-hidden": true,
              className: "size-4",
              strokeWidth: 2,
            }),
          };
        },
      },
    },
  ],
});
