import workerSource from "./mongoScriptWorker.js?raw";
import { uuid } from "@/lib/common/utils";

export interface MongoScriptSession {
  cancel: () => void;
  completion: Promise<void>;
}
/** User code runs in a worker inside an opaque-origin iframe with network denied by CSP. */
export function runMongoScriptSandbox(
  source: string,
  options: {
    request: (request: unknown, signal: AbortSignal) => Promise<unknown>;
    log: (values: unknown[]) => void;
    timeoutMs?: number;
  },
): MongoScriptSession {
  if (source.length > 100000) throw new Error("Script exceeds 100,000 characters");
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  const controller = new AbortController();
  const channel = uuid();
  let finished = false;
  let ready = false;
  let calls = 0;
  let logBytes = 0;
  let responseBytes = 0;
  let chain: Promise<void> = Promise.resolve();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const seen = new Set<number>();
  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    controller.abort();
    iframe.contentWindow?.postMessage({ channel, type: "stop" }, "*");
    window.removeEventListener("message", receive);
    iframe.remove();
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  }
  const timer = setTimeout(() => finish(new Error("Script timed out")), options.timeoutMs ?? 120000);
  function respond(id: number, value?: unknown, error?: string) {
    responseBytes += JSON.stringify(value ?? error ?? null).length;
    if (responseBytes > 64 * 1024 * 1024) {
      finish(new Error("Script read results exceed 64 MiB"));
      return;
    }
    if (!finished) iframe.contentWindow?.postMessage({ channel, type: "response", id, value, error }, "*");
  }
  function receive(event: MessageEvent) {
    if (event.source !== iframe.contentWindow || event.data?.channel !== channel || finished) return;
    const data = event.data;
    if (data.type === "ready" && !ready) {
      ready = true;
      iframe.contentWindow?.postMessage({ channel, type: "start", source }, "*");
    } else if (data.type === "rpc") {
      const request = data.request;
      if (!request || !Number.isSafeInteger(request.id) || seen.has(request.id) || ++calls > 1000) {
        finish(new Error("Invalid or excessive script requests"));
        return;
      }
      seen.add(request.id);
      chain = chain.then(async () => {
        if (finished) return;
        try {
          respond(request.id, await options.request(request, controller.signal));
        } catch (cause) {
          respond(request.id, undefined, String(cause));
        }
      });
    } else if (data.type === "log") {
      try {
        logBytes += JSON.stringify(data.values).length;
        if (logBytes > 1024 * 1024) throw new Error("Script output exceeds 1 MiB");
        options.log(Array.isArray(data.values) ? data.values : []);
      } catch (cause) {
        finish(new Error(String(cause)));
      }
    } else if (data.type === "done") {
      // Forgotten awaits must not start additional calls after completion.
      finish();
    } else if (data.type === "error") finish(new Error(String(data.message)));
  }
  window.addEventListener("message", receive);
  const bootstrap = [
    "const channel = " + JSON.stringify(channel) + ";",
    "const worker = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(workerSource) + "], {type:'text/javascript'})));",
    "worker.onmessage = ({data}) => parent.postMessage({...data, channel}, '*');",
    "worker.onerror = (e) => parent.postMessage({channel, type:'error', message:e.message}, '*');",
    "addEventListener('message', ({source, data}) => { if(source !== parent || data?.channel !== channel) return; if(data.type === 'stop') worker.terminate(); else worker.postMessage(data); });",
    "parent.postMessage({channel, type:'ready'}, '*');",
  ].join("\n");
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none';";
  iframe.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '"><script>' + bootstrap.replaceAll("</script", "<\\/script") + "</script>";
  document.body.appendChild(iframe);
  return { completion, cancel: () => finish(new Error("Script cancelled; confirmed writes are not rolled back")) };
}
