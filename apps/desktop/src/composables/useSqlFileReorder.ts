import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { sqlFileParentPath } from "@/lib/sqlFile/sqlFileOrder";

interface FileRow {
  root: string;
  path: string;
  name: string;
}

interface DropTarget extends FileRow {
  position: "before" | "after";
}

export function useSqlFileReorder(options: { tree: Ref<HTMLElement | null>; enabled: () => boolean; files: () => FileRow[]; drop: (source: FileRow, target: DropTarget) => void }) {
  const source = ref<FileRow | null>(null);
  const target = ref<DropTarget | null>(null);
  let pending: (FileRow & { x: number; y: number }) | null = null;
  let ghost: HTMLElement | null = null;
  let previousCursor = "";
  let previousUserSelect = "";
  let suppressClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | undefined;

  function suppressDragClick(event: MouseEvent) {
    if (!suppressClick || !(event.target instanceof Node) || !options.tree.value?.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function clearClickSuppression() {
    clearTimeout(suppressTimer);
    suppressClick = false;
    document.removeEventListener("click", suppressDragClick, true);
    document.removeEventListener("dblclick", suppressDragClick, true);
    document.removeEventListener("mouseup", releaseClickSuppression, true);
    document.removeEventListener("mousedown", clearClickSuppression, true);
  }

  function releaseClickSuppression(event?: MouseEvent) {
    if (event && event.button !== 0) return;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(clearClickSuppression, 0);
  }

  function cancel() {
    if (source.value) {
      // Escape/refresh can cancel while the mouse is still held. Suppress the
      // eventual release click, but allow the next independent mouse gesture.
      suppressClick = true;
      document.addEventListener("mouseup", releaseClickSuppression, true);
      document.addEventListener("mousedown", clearClickSuppression, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    }
    if (!suppressClick) {
      document.removeEventListener("click", suppressDragClick, true);
      document.removeEventListener("dblclick", suppressDragClick, true);
    }
    source.value = null;
    target.value = null;
    pending = null;
    ghost?.remove();
    ghost = null;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", end, true);
    document.removeEventListener("keydown", keydown, true);
    window.removeEventListener("blur", cancel);
  }

  function resolveTarget(x: number, y: number): DropTarget | null {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-sql-file-row]");
    if (!row || !options.tree.value?.contains(row) || !source.value) return null;
    const file = options.files().find((item) => item.root === row.dataset.sqlFileRoot && item.path === row.dataset.sqlFilePath);
    if (!file || file.root !== source.value.root || file.path === source.value.path || sqlFileParentPath(file.path) !== sqlFileParentPath(source.value.path)) return null;
    const rect = row.getBoundingClientRect();
    return { ...file, position: y < rect.top + rect.height / 2 ? "before" : "after" };
  }

  function move(event: MouseEvent) {
    if (!pending || !options.enabled() || (event.buttons & 1) === 0) {
      cancel();
      return;
    }
    if (!source.value) {
      if (Math.abs(event.clientX - pending.x) < 5 && Math.abs(event.clientY - pending.y) < 5) return;
      source.value = { root: pending.root, path: pending.path, name: pending.name };
      previousCursor = document.body.style.cursor;
      previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      ghost = document.createElement("div");
      ghost.textContent = pending.name;
      ghost.className = "pointer-events-none fixed z-[9999] max-w-[220px] truncate rounded border bg-background px-2 py-1 text-sm shadow-md opacity-90";
      document.body.appendChild(ghost);
    }
    event.preventDefault();
    if (ghost) {
      ghost.style.left = `${event.clientX + 8}px`;
      ghost.style.top = `${event.clientY - 12}px`;
    }
    target.value = resolveTarget(event.clientX, event.clientY);
  }

  function end(event: MouseEvent) {
    if (event.button !== 0) return;
    const dragged = source.value;
    const destination = options.enabled() ? resolveTarget(event.clientX, event.clientY) : null;
    cancel();
    if (suppressClick) releaseClickSuppression();
    if (dragged && destination) options.drop(dragged, destination);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  }

  function start(event: MouseEvent, root: string, path: string) {
    if (!options.enabled() || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement | null)?.closest("button, input, select, textarea, [contenteditable='true']")) return;
    const file = options.files().find((item) => item.root === root && item.path === path);
    if (!file) return;
    cancel();
    pending = { ...file, x: event.clientX, y: event.clientY };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", end, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("click", suppressDragClick, true);
    document.addEventListener("dblclick", suppressDragClick, true);
    window.addEventListener("blur", cancel);
  }

  watch(
    options.enabled,
    (enabled) => {
      if (!enabled) cancel();
    },
    { flush: "sync" },
  );

  onBeforeUnmount(() => {
    cancel();
    clearClickSuppression();
  });

  return { source, target, start, cancel };
}
