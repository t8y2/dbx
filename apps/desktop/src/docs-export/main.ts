import { createApp } from "vue";
import ExportApp from "./ExportApp.vue";
import { readPayload } from "./exportPayload";
import "./export.css";

try {
  createApp(ExportApp, { payload: readPayload() }).mount("#app");
} catch (error) {
  // A blank page would be the reader's only clue that the file is damaged.
  // English is not a choice here: `lang` lives inside the payload that just
  // failed to parse, so there is no locale to translate into.
  const message = document.createElement("p");
  message.style.cssText = "margin:2rem;font-family:system-ui,sans-serif";
  message.textContent = `This documentation file could not be read: ${error instanceof Error ? error.message : String(error)}`;
  document.querySelector("#app")?.replaceChildren(message);
}
