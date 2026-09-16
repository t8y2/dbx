export const EDITOR_MIN_FONT_SIZE = 10;
export const EDITOR_MAX_FONT_SIZE = 24;
const WHEEL_FONT_ZOOM_SENSITIVITY = 0.0015;
const WHEEL_GESTURE_IDLE_MS = 180;

type WheelZoomModifierEvent = Pick<WheelEvent, "ctrlKey" | "metaKey" | "timeStamp">;

export function createEditorWheelZoomGestureGuard(idleMs = WHEEL_GESTURE_IDLE_MS) {
  let lastEventTime = Number.NEGATIVE_INFINITY;
  let startedWithModifier = false;

  return {
    accepts(event: WheelZoomModifierEvent) {
      const hasModifier = event.metaKey || event.ctrlKey;
      const eventTime = Number.isFinite(event.timeStamp) ? event.timeStamp : 0;
      if (eventTime < lastEventTime || eventTime - lastEventTime > idleMs) {
        startedWithModifier = hasModifier;
      }
      lastEventTime = eventTime;
      return startedWithModifier && hasModifier;
    },
    reset() {
      lastEventTime = Number.NEGATIVE_INFINITY;
      startedWithModifier = false;
    },
  };
}

export function clampEditorFontSize(value: number): number {
  const clamped = Math.min(EDITOR_MAX_FONT_SIZE, Math.max(EDITOR_MIN_FONT_SIZE, value));
  return Number(clamped.toFixed(2));
}

export function fontSizeFromWheelDelta(currentFontSize: number, deltaY: number): number {
  return clampEditorFontSize(currentFontSize * Math.exp(-deltaY * WHEEL_FONT_ZOOM_SENSITIVITY));
}

export function fontSizeFromGestureScale(startFontSize: number, scale: number): number {
  return clampEditorFontSize(startFontSize * scale);
}

export function createEditorZoomCommitScheduler(commit: (fontSize: number) => void, delayMs = 160) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingFontSize: number | null = null;

  const clearPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(fontSize: number) {
      pendingFontSize = clampEditorFontSize(fontSize);
      clearPending();
      timer = setTimeout(() => {
        timer = null;
        const next = pendingFontSize;
        pendingFontSize = null;
        if (next !== null) commit(next);
      }, delayMs);
    },
    flush(fontSize?: number) {
      const next = clampEditorFontSize(fontSize ?? pendingFontSize ?? NaN);
      clearPending();
      pendingFontSize = null;
      if (!Number.isNaN(next)) commit(next);
    },
    hasPendingCommit() {
      return timer !== null;
    },
    dispose() {
      clearPending();
      pendingFontSize = null;
    },
  };
}
