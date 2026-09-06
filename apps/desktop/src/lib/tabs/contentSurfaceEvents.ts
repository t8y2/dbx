import type { ContentAreaSurfaceEmits } from "@/components/layout/querySurfaces";

/**
 * Single source of truth for the events every content surface forwards
 * upward. Each layer (QueryEditorSurface / QueryResultSurface / EditorGroup /
 * SqlEditorWorkspace) derives its v-bind handler object from this list, so the
 * four forwarding layers cannot drift apart when the contract changes.
 */
export const contentSurfaceEventNames = [
  "update:activeOutputView",
  "fixWithAi",
  "sendSelectionToAi",
  "previewChangesAvailable",
  "execute",
  "executeInNewResultTab",
  "saveSql",
  "cancel",
  "explain",
  "editorUpdate",
  "editorSelectionChange",
  "editorCursorChange",
  "editorViewportChange",
  "editorSelectionStateChange",
  "formatError",
  "reload",
  "paginate",
  "sort",
  "executeSql",
  "clickTable",
  "viewTableData",
  "viewTableDdl",
  "editTableStructure",
  "openObjectSource",
  "openObjectTable",
  "objectSchemaChange",
  "objectBrowserViewportChange",
  "objectBrowserSearchChange",
  "structureEditorSaved",
  "structureEditorClose",
  "previewStatement",
  "focusStatement",
  "openSettings",
  "openConnectionSettings",
  "toggleZenMode",
  "toggleResultsPane",
] as const satisfies Array<keyof ContentAreaSurfaceEmits>;

export type ContentSurfaceEventName = (typeof contentSurfaceEventNames)[number];

export type ContentSurfaceEventForwarders = {
  [K in ContentSurfaceEventName as `on${Capitalize<K & string>}`]: (...args: ContentAreaSurfaceEmits[K]) => void;
};

type ContentSurfaceEmit = <K extends ContentSurfaceEventName>(event: K, ...args: ContentAreaSurfaceEmits[K]) => void;

/**
 * Builds the v-bind event object that re-emits every shared content event.
 * Emitters stay typed through ContentAreaSurfaceEmits, so adding a new event
 * to the contract only requires extending the event list once.
 */
export function createContentSurfaceEventForwarders(emit: ContentSurfaceEmit): ContentSurfaceEventForwarders {
  const forwarders = {} as Record<string, (...args: unknown[]) => void>;
  for (const event of contentSurfaceEventNames) {
    const handlerName = `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
    forwarders[handlerName] = (...args: unknown[]) => {
      (emit as (event: ContentSurfaceEventName, ...args: unknown[]) => void)(event, ...args);
    };
  }
  return forwarders as ContentSurfaceEventForwarders;
}
