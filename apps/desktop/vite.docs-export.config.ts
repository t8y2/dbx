import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(__dirname, "../..");
const assetsDir = path.join(repoRoot, "crates/dbx-core/assets");
const fontPath = path.join(__dirname, "public/fonts/geist-latin-wght-normal.woff2");

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

interface BundleChunk {
  type: string;
  source?: string | Uint8Array;
  code?: string;
  modules?: Record<string, unknown>;
}

/**
 * Every `@import` a stylesheet actually makes, followed to the files on disk.
 *
 * Tailwind resolves CSS `@import` inside its own plugin, so tokens.css never
 * becomes a Rollup module and the module graph alone cannot see it. This
 * follows the same edges the build follows, from the same bytes — a new
 * `@import` is picked up because it is read out of the file, not matched
 * against a list. Bare specifiers (`tailwindcss`) resolve inside a package and
 * are left to `deps`.
 */
function cssImportsOf(file: string, seen: Set<string>): void {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
    const resolved = path.resolve(path.dirname(file), specifier);
    if (seen.has(resolved) || !isFile(resolved)) continue;
    seen.add(resolved);
    cssImportsOf(resolved, seen);
  }
}

/**
 * Inline the font and write the staleness manifest.
 *
 * The manifest is derived from Rollup's ACTUAL module graph — plus the CSS
 * `@import` graph the module graph cannot see — never from a hand-written
 * glob. SchemaDiagram.vue imports erDiagram.ts from outside src/docs/, so a
 * glob of that directory would miss it and the guard would pass while the
 * artefact was stale — the same shape as the three guards this feature has
 * already had to widen after the fact.
 *
 * New files are covered for free: a module can only enter the bundle by being
 * imported, which means editing an existing file, which changes that file's
 * hash. The one hole would be `import.meta.glob`, which the viewer does not
 * use.
 */
function exportBundlePlugin() {
  return {
    name: "dbx-docs-export",
    // Vite's own `vite:css-post` creates the stylesheet asset in its
    // generateBundle, and it runs after normal user plugins. Without `post`
    // this hook fires while the CSS does not exist yet and the `@font-face`
    // silently never lands.
    enforce: "post" as const,
    generateBundle(_options: unknown, bundle: Record<string, BundleChunk>) {
      const font = readFileSync(fontPath).toString("base64");
      const fontFace = `@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url("data:font/woff2;base64,${font}") format("woff2-variations")}\n`;

      const sources: Record<string, string> = {};
      const deps: Record<string, string> = {};

      const record = (rawId: string): void => {
        // Vue splits an SFC into `File.vue?vue&type=style&…` sub-requests and
        // Vite tags CSS the same way. The file on disk is the part before the
        // query; without stripping it every SFC would be missing from the
        // manifest, which is the failure this whole derivation exists to avoid.
        const id = rawId.split("?")[0];
        if (!path.isAbsolute(id)) return;

        // `lastIndexOf`: under pnpm a real path is
        // `<root>/node_modules/.pnpm/marked@18.0.4/node_modules/marked/…`, and
        // the FIRST occurrence yields the package name `.pnpm`.
        const nodeModules = id.lastIndexOf("/node_modules/");
        if (nodeModules !== -1) {
          const after = id.slice(nodeModules + "/node_modules/".length);
          const name = after.startsWith("@") ? after.split("/").slice(0, 2).join("/") : after.split("/")[0];
          if (name in deps) return;
          const manifest = path.join(id.slice(0, nodeModules), "node_modules", name, "package.json");
          if (!isFile(manifest)) return;
          deps[name] = JSON.parse(readFileSync(manifest, "utf8")).version;
          return;
        }

        if (!id.startsWith(repoRoot) || !isFile(id)) return;
        sources[path.relative(repoRoot, id)] = sha256(readFileSync(id));
      };

      const stylesheets = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        for (const id of Object.keys(chunk.modules ?? {})) {
          record(id);
          const file = id.split("?")[0];
          if (file.endsWith(".css") && isFile(file)) cssImportsOf(file, stylesheets);
        }
      }
      for (const file of stylesheets) record(file);
      record(fontPath);
      // This file, and the tsconfig esbuild reads `target` out of. Neither is a
      // module, and both decide emitted bytes: the @font-face template below,
      // `format: "iife"`, the `@source` narrowing. Without them someone can
      // change how the bundle is built, not rebuild, and leave the staleness
      // guard green over artefacts that no longer match the tree.
      record(__filename);
      record(path.join(__dirname, "tsconfig.json"));

      for (const [name, chunk] of Object.entries(bundle)) {
        if (name.endsWith(".css") && typeof chunk.source === "string") chunk.source = fontFace + chunk.source;
      }

      writeFileSync(
        path.join(assetsDir, "docs-export.manifest.json"),
        `${JSON.stringify({ sources: Object.fromEntries(Object.entries(sources).sort()), deps: Object.fromEntries(Object.entries(deps).sort()) }, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  root: __dirname,
  // The app's public/ holds the font files this build inlines. Left on, Vite
  // would copy all of them into crates/dbx-core/assets beside the bundle.
  publicDir: false,
  plugins: [vue(), tailwindcss(), exportBundlePlugin()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    outDir: assetsDir,
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, "src/docs-export/main.ts"),
      // `iife`, not the default `es`, for two reasons: Task 6 inlines this into
      // a document opened over file://, where a module script is subject to
      // CORS-flavoured rules no plain <script> has to satisfy — and an iife is
      // one file by construction, where an es bundle could split into chunks
      // the export would have to load over a network it does not have.
      output: { format: "iife", entryFileNames: "docs-export.js", assetFileNames: "docs-export.[ext]" },
    },
  },
});
