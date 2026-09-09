// This function is serialized into the sandbox. It must not capture module state.
function installBridge(channel) {
  let sequence = 0,
    context = {},
    locale = "zh-CN",
    theme;
  const pending = new Map(),
    listeners = { context: new Set(), init: new Set(), event: new Set(), binary: new Set() };
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let initialized = false;
  const readyTimer = setInterval(() => {
    if (!initialized) parent.postMessage({ source: "dbx-plugin", version: 1, channel, type: "ready" }, "*");
  }, 200);
  const encode = (input) => {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    let result = "";
    for (let i = 0; i < data.length; i += 8192) result += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(result);
  };
  const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Mock host request timed out"));
      }, 310000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ source: "dbx-plugin", version: 1, channel, type: "request", id, method, params }, "*");
    });
  const listen = (kind, callback) => {
    listeners[kind].add(callback);
    return () => listeners[kind].delete(callback);
  };
  function applyTheme(value) {
    if (!value) return;
    theme = value;
    document.documentElement.dataset.dbxTheme = value.appearance;
    for (const [name, token] of Object.entries(value.tokens || {})) {
      if (/^--[a-z0-9-]+$/i.test(name) && typeof token === "string") document.documentElement.style.setProperty(name, token);
    }
  }
  window.dbxPlugin = Object.freeze({
    ready,
    get context() {
      return context;
    },
    get locale() {
      return locale;
    },
    get theme() {
      return theme;
    },
    request,
    invoke: (method, params, options = {}) => request("backend.invoke", { method, params, timeoutMs: options.timeoutMs }),
    notify: (method, params) => request("backend.notify", { method, params }),
    sendBinary: (channel, data) => request("backend.sendBinary", { channel, dataBase64: typeof data === "string" ? data : encode(data) }),
    readAsset: (path) => request("ui.readAsset", { path }),
    readAssetUrl: async (path) => {
      const asset = await request("ui.readAsset", { path });
      return URL.createObjectURL(new Blob([decode(asset.dataBase64)], { type: asset.contentType }));
    },
    openWorkbench: (contributionId, context) => request("host.openWorkbench", { contributionId, context }),
    openFilesystem: (providerId, context) => request("host.openFilesystem", { providerId, context }),
    onContext: (fn) => listen("context", fn),
    onEvent: (fn) => listen("event", fn),
    onBinary: (fn) => listen("binary", fn),
    onInit: (fn) => {
      const off = listen("init", fn);
      if (initialized) fn(context);
      return off;
    },
    encodeBase64: encode,
    decodeBase64: decode,
  });
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || m?.source !== "dbx-host" || m.channel !== channel || m.version !== 1) return;
    if (m.type === "init") {
      initialized = true;
      clearInterval(readyTimer);
      context = m.context || {};
      locale = m.locale || "zh-CN";
      applyTheme(m.theme);
      resolveReady(context);
      for (const fn of listeners.init) fn(context);
      dispatchEvent(new CustomEvent("dbx-plugin-init", { detail: m }));
    }
    if (m.type === "context") {
      context = m.context || {};
      for (const fn of listeners.context) fn(context);
      dispatchEvent(new CustomEvent("dbx-plugin-context", { detail: context }));
    }
    if (m.type === "env") {
      locale = m.locale || locale;
      applyTheme(m.theme);
      for (const fn of listeners.event) fn(m);
      dispatchEvent(new CustomEvent("dbx-plugin-env", { detail: m }));
    }
    if (m.type === "event") {
      for (const fn of listeners.event) fn(m);
      dispatchEvent(new CustomEvent("dbx-plugin-event", { detail: m }));
    }
    if (m.type === "binary") {
      const payload = { channel: m.binaryChannel, data: decode(m.dataBase64) };
      for (const fn of listeners.binary) fn(payload);
      dispatchEvent(new CustomEvent("dbx-plugin-binary", { detail: payload }));
    }
    if (m.type === "response") {
      const waiter = pending.get(m.id);
      if (!waiter) return;
      pending.delete(m.id);
      clearTimeout(waiter.timer);
      if (m.error) waiter.reject(Object.assign(new Error(m.error.message || "Host request failed"), { code: m.error.code, data: m.error.data }));
      else waiter.resolve(m.result);
    }
  });
}

export function sandboxDocument(html, channel) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none';">`;
  const bootstrap = `<script>(${installBridge.toString()})(${JSON.stringify(channel)});</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (match) => match + csp + bootstrap);
  return `<!doctype html><html><head>${csp}${bootstrap}</head><body>${html}</body></html>`;
}
