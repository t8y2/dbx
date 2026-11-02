import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: {
        headingIds: false,
        stringify(node, _parent, state, info) {
          if (node.type !== "mdxJsxFlowElement") return;
          if (!["Tabs", "Tab", "Cards", "Card", "Steps", "Step", "Accordions", "Accordion", "Callout"].includes(node.name ?? "")) return;
          const attribute = (name: string) => {
            const entry = node.attributes.find((item) => item.type === "mdxJsxAttribute" && item.name === name);
            return entry && "value" in entry && typeof entry.value === "string" ? entry.value : undefined;
          };
          const title = attribute("title") ?? attribute("value");
          const href = attribute("href");
          const heading = title ? `### ${href ? `[${title}](${href})` : title}\n\n` : "";
          return heading + state.containerFlow(node, info);
        },
      },
    },
  },
});

export default defineConfig({
  mdxOptions: {},
});
