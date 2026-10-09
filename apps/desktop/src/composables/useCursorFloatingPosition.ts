import { ref, watch, type CSSProperties, type Ref } from "vue";
import { floatingCursorPosition } from "@/lib/common/floatingViewportPosition";

/** Measure after mounting and whenever the preview or viewport changes. Coordinates are CSS pixels. */
export function useCursorFloatingPosition(element: Ref<HTMLElement | null>, cursor: { x: number; y: number }, preferredSide: () => "left" | "right" = () => "right") {
  const style = ref<CSSProperties>({ visibility: "hidden" });
  function update() {
    const preview = element.value;
    if (!preview) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Apply constraints before measuring so truncation and narrow windows use the actual rendered size.
    preview.style.maxWidth = `min(20rem, ${Math.max(0, width - 16)}px)`;
    preview.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const position = floatingCursorPosition(cursor, preview.getBoundingClientRect(), { width, height }, preferredSide());
    style.value = { left: `${position.x}px`, top: `${position.y}px`, maxWidth: preview.style.maxWidth, maxHeight: preview.style.maxHeight };
  }
  watch([element, () => cursor.x, () => cursor.y, preferredSide], update, { flush: "post" });
  watch(
    element,
    (preview, _, onCleanup) => {
      if (!preview) {
        style.value = { visibility: "hidden" };
        return;
      }
      const observer = new ResizeObserver(update);
      observer.observe(preview);
      window.addEventListener("resize", update);
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener("resize", update);
      });
    },
    { flush: "post" },
  );
  return style;
}
