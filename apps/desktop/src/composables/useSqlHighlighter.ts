import { onMounted, ref } from "vue";
import { useTheme } from "@/composables/useTheme";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sql/sqlHighlighter";

export function useSqlHighlighter() {
  const { isDark } = useTheme();
  const sqlHighlighter = ref<SqlHighlighter>();

  onMounted(async () => {
    sqlHighlighter.value = await createShikiSqlHighlighter({
      appearance: () => (isDark.value ? "dark" : "light"),
    });
  });

  function highlight(sql: string): string {
    return sqlHighlighter.value?.(sql) ?? sql;
  }

  return { highlight, sqlHighlighter };
}
