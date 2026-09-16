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
  const stream = async (method, params = {}, options = {}) => {
    const streamId = options.streamId || globalThis.crypto?.randomUUID?.() || "stream-" + Date.now() + "-" + ++sequence;
    const closeMethod = options.closeMethod || "filesystem/stream/close";
    let removeListener;
    let closeRequested = false;
    let resolveOpen;
    let rejectOpen;
    const metadata = {};
    const opened = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const readable = new ReadableStream({
      start(controller) {
        const onEvent = (message) => {
          if (message?.method !== "host.stream.chunk" && message?.method !== "host.stream.end" && message?.method !== "host.stream.error") return;
          const event = message.params || {};
          if (event.streamId !== streamId) return;
          if (message.method === "host.stream.chunk") {
            try {
              controller.enqueue(decode(event.dataBase64 || ""));
            } catch (error) {
              controller.error(error);
            }
            return;
          }
          removeListener?.();
          removeListener = undefined;
          if (message.method === "host.stream.error") {
            const error = new Error(event.message || "Plugin stream failed");
            rejectOpen(error);
            controller.error(error);
          } else {
            Object.assign(metadata, event);
            controller.close();
          }
        };
        removeListener = () => listeners.event.delete(onEvent);
        listeners.event.add(onEvent);
        request("backend.invoke", { method, params: { ...params, streamId }, timeoutMs: options.timeoutMs }).then(resolveOpen, (error) => {
          removeListener?.();
          removeListener = undefined;
          rejectOpen(error);
          controller.error(error);
        });
      },
      cancel() {
        removeListener?.();
        removeListener = undefined;
        if (closeRequested) return undefined;
        closeRequested = true;
        return request("backend.invoke", { method: closeMethod, params: { streamId } }).catch(() => undefined);
      },
    });
    Object.assign(metadata, await opened);
    return { stream: readable, metadata };
  };
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
    stream,
    notify: (method, params) => request("backend.notify", { method, params }),
    sendBinary: (channel, data) => request("backend.sendBinary", { channel, dataBase64: typeof data === "string" ? data : encode(data) }),
    readAsset: (path) => request("ui.readAsset", { path }),
    readAssetUrl: async (path) => {
      const asset = await request("ui.readAsset", { path });
      return URL.createObjectURL(new Blob([decode(asset.dataBase64)], { type: asset.contentType }));
    },
    openWorkbench: (contributionId, context) => request("host.openWorkbench", { contributionId, context }),
    openFilesystem: (providerId, context) => request("host.openFilesystem", { providerId, context }),
    copy: (text) => request("host.copy", { text }),
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

export function sandboxDocument(html, channel, assets = new Map()) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none';">`;
  const bootstrap = `<script>(${installBridge.toString()})(${JSON.stringify(channel)});</script>`;
  const inlineAsset = (url) => {
    const asset = assets.get(url);
    if (!asset) return undefined;
    return Buffer.from(asset.dataBase64, "base64").toString("utf8");
  };
  const withInlineScripts = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi, (match, before, _quote, url, after) => {
    const content = inlineAsset(url);
    return content === undefined ? match : `<script${before}${after}>${content.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
  const withInlineStyles = withInlineScripts.replace(/<link\b([^>]*)>/gi, (match, attributes) => {
    if (!/\brel\s*=\s*(["'])[^"']*\bstylesheet\b[^"']*\1/i.test(attributes)) return match;
    const href = attributes.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (!href) return match;
    const content = inlineAsset(href[2]);
    return content === undefined ? match : `<style>${content.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
  if (/<head\b[^>]*>/i.test(withInlineStyles)) return withInlineStyles.replace(/<head\b[^>]*>/i, (match) => match + csp + bootstrap);
  return `<!doctype html><html><head>${csp}${bootstrap}</head><body>${withInlineStyles}</body></html>`;
}
