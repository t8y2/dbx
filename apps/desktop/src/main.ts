import { createApp } from "vue";
import { createPinia } from "pinia";
import VueVirtualScroller from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import "./styles/globals.css";

function startupErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join("\n");
  }
  return String(error);
}

function renderStartupError(error: unknown) {
  const message = startupErrorMessage(error);
  console.error("[STARTUP] bootstrap failed", error);
  const root = document.querySelector<HTMLDivElement>("#root");
  if (!root) return;
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.style.cssText = [
    "display:flex",
    "min-height:100vh",
    "align-items:center",
    "justify-content:center",
    "background:#ffffff",
    "color:#111827",
    "padding:24px",
    "font-family:ui-sans-serif,system-ui,sans-serif",
  ].join(";");
  const card = document.createElement("div");
  card.style.cssText = [
    "max-width:760px",
    "width:100%",
    "border:1px solid #e5e7eb",
    "border-radius:12px",
    "padding:20px",
    "box-shadow:0 10px 30px rgba(0,0,0,0.08)",
    "background:#fff",
  ].join(";");
  const title = document.createElement("h1");
  title.textContent = "DBX startup failed";
  title.style.cssText = "margin:0 0 12px;font-size:18px;font-weight:700;";
  const text = document.createElement("p");
  text.textContent = "The desktop UI crashed during startup. Please copy the error below and send it to the DBX team.";
  text.style.cssText = "margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563;";
  const pre = document.createElement("pre");
  pre.textContent = message;
  pre.style.cssText = [
    "margin:0",
    "white-space:pre-wrap",
    "word-break:break-word",
    "font-size:12px",
    "line-height:1.5",
    "background:#f9fafb",
    "border-radius:8px",
    "padding:12px",
    "overflow:auto",
  ].join(";");
  card.append(title, text, pre);
  panel.append(card);
  root.append(panel);
}

function installStartupErrorHandlers() {
  window.addEventListener("error", (event) => {
    console.error("[STARTUP] window error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[STARTUP] unhandled rejection", event.reason);
  });
}

async function bootstrap() {
  console.log("[STARTUP] frontend bootstrap begin");
  const [{ default: i18n, loadSavedLocale }, { default: App }] = await Promise.all([
    import("./i18n"),
    import("./App.vue"),
  ]);
  console.log("[STARTUP] frontend modules loaded");
  await loadSavedLocale();
  console.log("[STARTUP] locale ready");

  const app = createApp(App);
  app.use(createPinia());
  app.use(i18n);
  app.use(VueVirtualScroller);
  app.mount("#root");
  console.log("[STARTUP] vue mounted");
}

installStartupErrorHandlers();
void bootstrap().catch(renderStartupError);
