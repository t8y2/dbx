import { ref, type Ref } from "vue";
import type { DiffHunk } from "@/components/diff/DiffHunkBuilder";

export interface UseDiffScrollSyncOptions {
  container: Ref<HTMLElement | undefined>;
  leftPane: Ref<HTMLElement | undefined>;
  rightPane: Ref<HTMLElement | undefined>;
  hunks: Ref<DiffHunk[]>;
}

export function useDiffScrollSync({ container, leftPane, rightPane, hunks }: UseDiffScrollSyncOptions) {
  const isSyncingScroll = ref(false);

  function syncScroll(from: "left" | "right") {
    if (isSyncingScroll.value) return;
    const source = from === "left" ? leftPane.value : rightPane.value;
    const target = from === "left" ? rightPane.value : leftPane.value;
    if (!source || !target) return;
    isSyncingScroll.value = true;
    target.scrollTop = source.scrollTop;
    isSyncingScroll.value = false;
  }

  function measureHunks() {
    const outer = container.value;
    const left = leftPane.value;
    const right = rightPane.value;
    if (!outer || !left || !right) return;

    const outerRect = outer.getBoundingClientRect();

    for (const hunk of hunks.value) {
      const leftEl = left.querySelector(`[data-hunk-id="${hunk.id}"]`) as HTMLElement | null;
      const rightEl = right.querySelector(`[data-hunk-id="${hunk.id}"]`) as HTMLElement | null;
      if (leftEl) {
        const rect = leftEl.getBoundingClientRect();
        hunk.leftTop = rect.top - outerRect.top;
        hunk.leftBottom = rect.bottom - outerRect.top;
      }
      if (rightEl) {
        const rect = rightEl.getBoundingClientRect();
        hunk.rightTop = rect.top - outerRect.top;
        hunk.rightBottom = rect.bottom - outerRect.top;
      }
    }
  }

  return {
    syncScroll,
    measureHunks,
  };
}
