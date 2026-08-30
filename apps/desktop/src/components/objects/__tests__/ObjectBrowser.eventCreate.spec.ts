import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../layout/ContentArea.vue", import.meta.url), "utf8");

function functionBody(name: string, source: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser MySQL Event CREATE navigation", () => {
  it("accepts an explicit create request prop next to the edit props", () => {
    expect(objectBrowserSource).toContain("initialEventCreateRequestId?: number;");
    expect(objectBrowserSource).toMatch(/initialEventName\?: string;[\s\S]*?initialEventCreateRequestId\?: number;[\s\S]*?initialObjectFilter\?: "tables" \| "events";/);
  });

  it("routes the initial event request through the shared resolver", () => {
    const openInitialEventIfNeeded = functionBody("openInitialEventIfNeeded", objectBrowserSource);
    expect(openInitialEventIfNeeded).toContain("resolveInitialEventEditorRequest({");
    expect(openInitialEventIfNeeded).toContain("eventCreateRequestId: props.initialEventCreateRequestId");
    expect(openInitialEventIfNeeded).toContain("openedRequestKey: openedInitialEvent.value");
    expect(openInitialEventIfNeeded).toContain("hasEventRow: rows.value.some");
    expect(openInitialEventIfNeeded).toContain("loadingObjects: loadingObjects.value");
  });

  it("opens the CREATE editor without any existing EVENT row", () => {
    const openInitialEventIfNeeded = functionBody("openInitialEventIfNeeded", objectBrowserSource);
    expect(openInitialEventIfNeeded).toContain('if (decision.type === "create") {');
    expect(openInitialEventIfNeeded).toContain("sidePanelRow.value = null;");
    expect(openInitialEventIfNeeded).toContain('sidePanelMode.value = "event-editor";');
    expect(openInitialEventIfNeeded).toContain("openedInitialEvent.value = decision.requestKey;");
    // The editor must see an empty name so MySqlEventEditor renders CREATE mode
    expect(openInitialEventIfNeeded).not.toContain("sidePanelRow.value = row;");
  });

  it("keeps the CREATE editor mounted when there is no EVENT row", () => {
    expect(objectBrowserSource).toContain('v-if="sidePanelRow || isEventEditor"');
    expect(objectBrowserSource).toContain('<MySqlEventEditor :key="eventEditorKey"');
  });

  it("renders the editor with an empty CREATE name and request-scoped instance", () => {
    expect(objectBrowserSource).toContain('<MySqlEventEditor :key="eventEditorKey" :connection="props.connection" :database="props.database" :schema="sidePanelRow?.schema || selectedSchema || props.database" :name="sidePanelRow?.name"');
    expect(objectBrowserSource).toMatch(/const eventEditorKey = computed\(\(\) =>[\s\S]*?createRequestId: props\.initialEventCreateRequestId[\s\S]*?openRequestId: props\.initialEventOpenRequestId[\s\S]*?rowId: sidePanelRow\.value\?\.id/);
  });

  it("re-triggers a create request when the request id changes on a reused tab", () => {
    expect(objectBrowserSource).toContain("() => props.initialEventCreateRequestId");
    expect(objectBrowserSource).toMatch(/watch\(\[\(\) => props\.initialEventName, \(\) => props\.initialEventOpenRequestId, \(\) => props\.initialEventCreateRequestId\][\s\S]*?openedInitialEvent\.value = "";[\s\S]*?openInitialEventIfNeeded\(\);/);
  });

  it("lists the events filter as the preferred view for a create request", () => {
    expect(objectBrowserSource).toMatch(/const preferredFilter = props\.initialObjectFilter \?\? \(props\.initialEventName \|\| props\.initialEventCreateRequestId !== undefined \? "events" : "tables"\);/);
  });

  it("ContentArea passes the create request id into ObjectBrowser", () => {
    expect(contentAreaSource).toContain(':initial-event-name="activeTab.objectBrowser?.eventName"');
    expect(contentAreaSource).toContain(':initial-event-create-request-id="activeTab.objectBrowser?.eventCreateRequestId"');
  });
});
