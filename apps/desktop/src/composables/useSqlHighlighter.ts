import { ref } from "vue";
import { useTheme } from "@/composables/useTheme";
import { type SqlHighlighter, createShikiSqlHighlighter, escapeHtml } from "@/lib/sql/sqlHighlighter";

export function useSqlHighlighter() {
  const { isDark } = useTheme();
  const sqlHighlighter = ref<SqlHighlighter>();
  let requested = false;

  // Shiki plus its grammar and themes cost tens of MB of WebView memory, and many
  // always-mounted hosts only highlight once a SQL preview is actually shown, so the
  // highlighter loads on the first highlight() call instead of on component mount.
  function ensureLoaded() {
    if (requested) return;
    requested = true;
    void createShikiSqlHighlighter({
      appearance: () => (isDark.value ? "dark" : "light"),
    }).then((highlighter) => {
      sqlHighlighter.value = highlighter;
    });
  }

  function highlight(sql: string): string {
    ensureLoaded();
    return sqlHighlighter.value?.(sql) ?? escapeHtml(sql);
  }

  return { highlight, sqlHighlighter };
}
