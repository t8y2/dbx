import { watch, onBeforeUnmount, type Ref } from "vue";
import { isPanelResizing } from "@/lib/app/panelResizeState";
import { uiTuning } from "@/lib/app/uiTuning";

export function useQueryEditorLayout(editorRef: Ref<HTMLDivElement | undefined>) {
  // While any panel divider is dragged, CodeMirror re-wraps and re-measures
  // every visible line on every frame the editor box changes — with a 100+ line
  // script that is the dominant drag cost (profiler: 2k+ measure() calls with
  // getBoundingClientRect in a 3s drag). We pin the editor root to an explicit
  // pixel size and then step-update that pin at most every TRACK_EVERY_FRAMES
  // animation frames (~30fps), which keeps the editor visually following the
  // divider while cutting the relayout frequency (and the layout thrash from
  // interleaved reads/writes) by half or more. The step interval is tunable via
  // ~/.dbx/ui-tuning.json (panelResizeTrackEveryFrames). The pin is released
  // once on pointer-up for one final exact layout.
  let frozenEditorBox: { width: number; height: number } | null = null;
  let editorTrackFrameId = 0;
  let editorTrackFrameCount = 0;

  function editorAvailableSize(): { width: number; height: number } | null {
    const host = editorRef.value?.parentElement;
    if (!host) return null;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  function pinEditorBox(size: { width: number; height: number }) {
    const root = editorRef.value;
    if (!root) return;
    frozenEditorBox = size;
    root.style.width = `${Math.round(size.width)}px`;
    root.style.height = `${Math.round(size.height)}px`;
    root.style.maxWidth = "none";
    root.style.minHeight = "0";
  }

  function releaseEditorBox() {
    const root = editorRef.value;
    frozenEditorBox = null;
    if (!root) return;
    root.style.width = "";
    root.style.height = "";
    root.style.maxWidth = "";
    root.style.minHeight = "";
  }

  function stopEditorBoxTracking() {
    if (editorTrackFrameId) {
      cancelAnimationFrame(editorTrackFrameId);
      editorTrackFrameId = 0;
    }
    editorTrackFrameCount = 0;
  }

  function editorBoxTrackStep() {
    editorTrackFrameId = requestAnimationFrame(editorBoxTrackStep);
    if (++editorTrackFrameCount < uiTuning.value.panelResizeTrackEveryFrames) return;
    editorTrackFrameCount = 0;
    const next = editorAvailableSize();
    if (!next || !frozenEditorBox) return;
    if (Math.round(next.width) === Math.round(frozenEditorBox.width) && Math.round(next.height) === Math.round(frozenEditorBox.height)) return;
    // Writing the pin keeps the editor a fixed-size box: the parent's layout is
    // reflowed (cheap, the editor subtree is `contain`ed and skipped) but
    // CodeMirror only observes one discrete size change per step.
    pinEditorBox(next);
  }

  watch(
    isPanelResizing,
    (resizing) => {
      const root = editorRef.value;
      if (!root) return;
      if (resizing) {
        if (frozenEditorBox) return;
        const size = editorAvailableSize();
        if (!size) return;
        pinEditorBox(size);
        editorTrackFrameId = requestAnimationFrame(editorBoxTrackStep);
      } else {
        stopEditorBoxTracking();
        if (frozenEditorBox) releaseEditorBox();
      }
    },
    { flush: "sync" },
  );
  onBeforeUnmount(stopEditorBoxTracking);
}
