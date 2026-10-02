import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * CodeMirror's gutter view re-syncs every gutter element whenever the viewport
 * moves, and for a viewport change that covers more than 20% of the viewport it
 * first detaches `.cm-gutters` from the scroller and re-inserts it afterwards,
 * on the assumption that mutating a detached subtree is cheaper. On WebKit the
 * opposite is true: re-inserting a `position: sticky` subtree whose inline
 * `min-height` is the full content height (~41 000px for a 2 500 line script)
 * forces a style recalculation and a layout of the whole scroller on the next
 * frame. Scrolling a long script therefore spends ~5ms of the ~10ms of
 * per-frame main-thread work in the re-insert, and the frames that pay it are
 * exactly the ones a fast scroll produces.
 *
 * Measured on the shipped 2 500 line script, scrolling the same page three
 * times in one run (gutter sync as CodeMirror ships it / sync forced to update
 * in place / as CodeMirror ships it): per frame, `view.measure()` 9.26ms →
 * 4.15ms → 8.23ms, of which computed-style resolution 4.27ms → 1.40ms → 4.14ms
 * and `getBoundingClientRect` 1.86ms → 1.16ms → 1.73ms; frame gap mean
 * 20.3ms → 15.0ms → 18.6ms. Hiding `.cm-gutters` entirely accounts for the
 * same ~5ms, so the difference is the detach/re-insert and not the gutter
 * content.
 *
 * The in-place path is the same code with the detach flag off, which is what
 * CodeMirror already does for viewport changes below that threshold: the
 * elements a sync has to update are always bounded by the size of the viewport,
 * never by how far the viewport moved. So the shadow only forces the flag off;
 * everything else about the sync is CodeMirror's.
 */

interface GutterSyncHost {
  dom?: { classList?: { contains: (token: string) => boolean } } | null;
  syncGutters?: (detach: boolean) => void;
}

const SYNC_GUTTERS = "syncGutters";

/**
 * The gutter view is a CodeMirror plugin value, and `view.plugins` is the only
 * way to reach it. Identify it by the element it owns rather than by position,
 * because the plugin list order is not part of the public API.
 */
function gutterSyncHost(view: EditorView): GutterSyncHost | null {
  const plugins = (view as unknown as { plugins?: readonly { value?: unknown }[] }).plugins;
  if (!plugins) return null;
  for (const plugin of plugins) {
    const value = plugin?.value as GutterSyncHost | undefined;
    if (!value || typeof value.syncGutters !== "function") continue;
    if (value.dom?.classList?.contains("cm-gutters")) return value;
  }
  return null;
}

interface GutterSyncGuard {
  host: GutterSyncHost;
  guarded: (detach: boolean) => void;
  original: (detach: boolean) => void;
}

function attachGutterSyncGuard(view: EditorView): GutterSyncGuard | null {
  const host = gutterSyncHost(view);
  if (!host || typeof host.syncGutters !== "function") return null;
  // Never clobber a shadow somebody else owns; without ours, the prototype
  // method is what CodeMirror calls, and that is what we restore.
  if (Object.prototype.hasOwnProperty.call(host, SYNC_GUTTERS)) return null;
  const original = host.syncGutters;
  const guarded = (_detach: boolean) => original.call(host, false);
  host[SYNC_GUTTERS] = guarded;
  return { host, guarded, original };
}

function releaseGutterSyncGuard(guard: GutterSyncGuard): void {
  if (guard.host[SYNC_GUTTERS] === guard.guarded) delete guard.host[SYNC_GUTTERS];
}

/**
 * Keeps the gutter DOM attached to the scroller while CodeMirror syncs it.
 *
 * Nothing about the gutter's content, layout or behaviour changes — the
 * detached sync CodeMirror performs is the same element updates, and a detached
 * element cannot report its width to the gutter's `scrollMargins` provider while
 * it is out of the document either.
 */
export function keepGuttersAttachedDuringSync(ViewPlugin: typeof import("@codemirror/view").ViewPlugin): Extension {
  return ViewPlugin.fromClass(
    class {
      private guard: GutterSyncGuard | null = null;

      constructor(view: EditorView) {
        this.guard = attachGutterSyncGuard(view);
      }

      update(update: import("@codemirror/view").ViewUpdate) {
        // The gutter plugin may be created after this one, and a reconfigure
        // that swaps the gutter extensions replaces the plugin value, so the
        // guard is re-attached until it is holding the live host.
        const held = this.guard;
        if (held && held.host === gutterSyncHost(update.view) && held.host[SYNC_GUTTERS] === held.guarded) return;
        if (held) releaseGutterSyncGuard(held);
        this.guard = attachGutterSyncGuard(update.view);
      }

      destroy() {
        if (this.guard) releaseGutterSyncGuard(this.guard);
        this.guard = null;
      }
    },
  );
}
