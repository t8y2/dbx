import { ref } from "vue";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import type { Theme } from "@tauri-apps/api/window";

export function useTheme() {
  const isDark = ref(localStorage.getItem("dbx-theme") === "dark");

  function applyTheme() {
    document.documentElement.classList.toggle("dark", isDark.value);
    if (!isTauriRuntime()) return;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .setTheme(isDark.value ? "dark" as Theme : "light" as Theme)
        .catch(() => {});
    });
  }

  function toggleTheme() {
    isDark.value = !isDark.value;
    localStorage.setItem("dbx-theme", isDark.value ? "dark" : "light");
    applyTheme();
  }

  return { isDark, applyTheme, toggleTheme };
}
