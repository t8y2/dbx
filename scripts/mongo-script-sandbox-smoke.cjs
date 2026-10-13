// In-process tests of the real parent bridge. DOM/messages/timers are mocks:
// these checks do NOT execute an iframe/Worker or prove browser CSP isolation.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

module.exports = (test, assert, _load) => {
  const directory = path.resolve(__dirname, "../apps/desktop/src/lib/mongo");
  const filename = path.join(directory, "mongoScriptSandbox.ts");
  const workerSource = fs.readFileSync(path.join(directory, "mongoScriptWorker.js"), "utf8");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
    fileName: filename,
  }).outputText;

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const flush = async (turns = 12) => {
    for (let i = 0; i < turns; i++) await Promise.resolve();
  };
  const plain = (value) => JSON.parse(JSON.stringify(value));

  function harness(request = async () => null, extra = {}) {
    const listeners = new Set();
    const timers = new Map();
    const frames = [];
    const outgoing = [];
    const logs = [];
    const channel = "smoke-sandbox-channel-001";
    let timerSequence = 0;
    let removes = 0;
    const document = {
      createElement(tag) {
        assert.equal(tag, "iframe");
        const iframe = {
          attributes: {},
          hidden: false,
          srcdoc: "",
          attached: false,
          contentWindow: {
            postMessage(data, origin) {
              outgoing.push({ data, origin });
            },
          },
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          remove() {
            this.attached = false;
            removes++;
          },
        };
        frames.push(iframe);
        return iframe;
      },
      body: {
        appendChild(iframe) {
          assert.ok(frames.includes(iframe));
          iframe.attached = true;
        },
      },
    };
    const window = {
      addEventListener(name, receive) {
        assert.equal(name, "message");
        listeners.add(receive);
      },
      removeEventListener(name, receive) {
        assert.equal(name, "message");
        listeners.delete(receive);
      },
    };
    const module = { exports: {} };
    const context = vm.createContext({
      module,
      exports: module.exports,
      document,
      window,
      AbortController,
      crypto: { randomUUID: () => channel },
      setTimeout(callback, milliseconds) {
        const id = ++timerSequence;
        timers.set(id, { callback, milliseconds });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      require(specifier) {
        // Substitute only Vite's raw import with the actual checked-in worker text.
        if (specifier === "./mongoScriptWorker.js?raw") return workerSource;
        if (specifier === "@/lib/common/utils") return { uuid: () => channel };
        throw new Error(`Unexpected sandbox import: ${specifier}`);
      },
    });
    vm.runInContext(compiled, context, { filename, timeout: 5000 });
    const source = extra.source ?? "await db.items.find({}).toArray();";
    const session = module.exports.runMongoScriptSandbox(source, {
      request,
      log: (values) => logs.push(values),
      timeoutMs: extra.timeoutMs,
    });
    // Attach a rejection handler immediately; cancellation is an expected outcome.
    const outcome = session.completion.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    const iframe = frames[0];
    function emit(data, eventSource = iframe.contentWindow, eventChannel = channel) {
      for (const receive of [...listeners]) receive({ source: eventSource, data: { ...data, channel: eventChannel } });
    }
    function rpc(id) {
      emit({ type: "rpc", request: { id, method: "find", collection: "items", args: [{}] } });
    }
    function cleaned() {
      assert.equal(listeners.size, 0, "message listener removed");
      assert.equal(timers.size, 0, "timeout cleared");
      assert.equal(iframe.attached, false, "iframe detached");
      assert.equal(removes, 1, "cleanup is idempotent");
      assert.equal(outgoing.filter((message) => message.data.type === "stop").length, 1, "worker stop sent once");
    }
    return { session, outcome, iframe, timers, outgoing, logs, emit, rpc, cleaned, channel, source, listeners };
  }

  test("sandbox parent bridge rejects wrong message source/channel and starts once", async () => {
    let requests = 0;
    const h = harness(async () => {
      requests++;
      return [];
    });
    try {
      assert.equal(h.iframe.hidden, true);
      assert.equal(h.iframe.attributes.sandbox, "allow-scripts");
      assert.equal(h.iframe.attributes["aria-hidden"], "true");
      assert.equal(h.iframe.attached, true);
      // Structural assertions only, not claims about browser CSP enforcement.
      assert.ok(h.iframe.srcdoc.includes("connect-src 'none'"));
      assert.ok(h.iframe.srcdoc.includes(JSON.stringify(workerSource).replaceAll("</script", "<\/script")));
      for (const data of [
        { type: "ready" },
        { type: "rpc", request: { id: 1 } },
        { type: "log", values: ["forged"] },
        { type: "done" },
        { type: "error", message: "forged" },
      ]) {
        h.emit(data, {}, h.channel);
        h.emit(data, h.iframe.contentWindow, "other-channel");
      }
      await flush();
      assert.equal(h.outgoing.length, 0);
      assert.equal(requests, 0);
      assert.equal(h.logs.length, 0);
      assert.equal(h.listeners.size, 1);
      h.emit({ type: "ready" });
      h.emit({ type: "ready" });
      const starts = h.outgoing.filter((message) => message.data.type === "start");
      assert.equal(starts.length, 1);
      assert.deepEqual(plain(starts[0]), { data: { channel: h.channel, type: "start", source: h.source }, origin: "*" });
      h.emit({ type: "log", values: ["valid", 7] });
      assert.deepEqual(plain(h.logs), [["valid", 7]]);
      h.emit({ type: "done" });
      assert.equal((await h.outcome).ok, true);
      h.cleaned();
    } finally {
      h.session.cancel();
      await h.outcome;
    }
  });

  test("sandbox parent bridge serializes RPC and returns per-request failures", async () => {
    const first = deferred();
    const second = deferred();
    const calls = [];
    let active = 0;
    let peak = 0;
    const h = harness(async (request, signal) => {
      calls.push(request.id);
      assert.equal(signal.aborted, false);
      active++;
      peak = Math.max(peak, active);
      try {
        return await (request.id === 1 ? first.promise : second.promise);
      } finally {
        active--;
      }
    });
    try {
      h.rpc(1);
      h.rpc(2);
      await flush();
      assert.deepEqual(calls, [1]);
      assert.equal(h.outgoing.filter((message) => message.data.type === "response").length, 0);
      first.reject(new Error("isolated request failure"));
      await flush();
      assert.deepEqual(calls, [1, 2]);
      const failed = h.outgoing.find((message) => message.data.type === "response" && message.data.id === 1);
      assert.match(failed.data.error, /isolated request failure/);
      second.resolve([{ value: 2 }]);
      await flush();
      assert.equal(peak, 1);
      const reply = h.outgoing.find((message) => message.data.type === "response" && message.data.id === 2);
      assert.deepEqual(plain(reply.data.value), [{ value: 2 }]);
      h.emit({ type: "done" });
      assert.equal((await h.outcome).ok, true);
      h.cleaned();
    } finally {
      first.resolve([]);
      second.resolve([]);
      h.session.cancel();
      await h.outcome;
    }
  });

  test("sandbox parent bridge accepts exactly 1000 RPCs and rejects call 1001", async () => {
    let count = 0;
    const h = harness(async () => {
      count++;
      return null;
    });
    try {
      for (let id = 1; id <= 1000; id++) {
        h.rpc(id);
        await flush(6);
      }
      assert.equal(count, 1000);
      assert.equal(h.outgoing.filter((message) => message.data.type === "response").length, 1000);
      assert.equal(h.listeners.size, 1);
      h.rpc(1001);
      const result = await h.outcome;
      assert.equal(result.ok, false);
      assert.match(String(result.error), /Invalid or excessive script requests/);
      assert.equal(count, 1000);
      h.cleaned();
    } finally {
      h.session.cancel();
      await h.outcome;
    }
  });

  test("sandbox parent bridge rejects duplicate and non-safe-integer request IDs", async () => {
    for (const invalid of [1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, "2"]) {
      let count = 0;
      const h = harness(async () => {
        count++;
        return null;
      });
      try {
        h.rpc(1);
        await flush();
        h.rpc(invalid);
        const result = await h.outcome;
        assert.equal(result.ok, false);
        assert.match(String(result.error), /Invalid or excessive script requests/);
        assert.equal(count, 1);
        h.cleaned();
      } finally {
        h.session.cancel();
        await h.outcome;
      }
    }
  });

  test("sandbox cancellation aborts active RPC, drops queued calls and ignores late responses", async () => {
    const first = deferred();
    const calls = [];
    let signal;
    let aborts = 0;
    const h = harness(async (request, value) => {
      calls.push(request.id);
      signal = value;
      signal.addEventListener("abort", () => aborts++);
      return first.promise;
    });
    try {
      h.rpc(1);
      h.rpc(2);
      await flush();
      assert.deepEqual(calls, [1]);
      h.session.cancel();
      h.session.cancel();
      const result = await h.outcome;
      assert.equal(result.ok, false);
      assert.match(String(result.error), /Script cancelled/);
      assert.equal(signal.aborted, true);
      assert.equal(aborts, 1);
      h.cleaned();
      first.resolve([{ late: true }]);
      await flush();
      h.rpc(3);
      h.emit({ type: "log", values: ["late"] });
      await flush();
      assert.deepEqual(calls, [1]);
      assert.equal(h.outgoing.filter((message) => message.data.type === "response").length, 0);
      assert.equal(h.logs.length, 0);
      h.cleaned();
    } finally {
      first.resolve([]);
      h.session.cancel();
      await h.outcome;
    }
  });

  test("sandbox timeout aborts active RPC and clears the DOM/listener/timer", async () => {
    const pending = deferred();
    let signal;
    const h = harness(
      async (_request, value) => {
        signal = value;
        return pending.promise;
      },
      { timeoutMs: 37 },
    );
    try {
      h.rpc(1);
      await flush();
      const [id, timer] = [...h.timers.entries()][0];
      assert.equal(timer.milliseconds, 37);
      // Fake timer firing is synchronous; no real sleep or child process.
      h.timers.delete(id);
      timer.callback();
      const result = await h.outcome;
      assert.equal(result.ok, false);
      assert.match(String(result.error), /Script timed out/);
      assert.equal(signal.aborted, true);
      h.cleaned();
      pending.resolve([]);
      await flush();
      assert.equal(h.outgoing.filter((message) => message.data.type === "response").length, 0);
    } finally {
      pending.resolve([]);
      h.session.cancel();
      await h.outcome;
    }
  });

  test("sandbox done abandons forgotten-await queued RPCs and aborts active request", async () => {
    const pending = deferred();
    const calls = [];
    let signal;
    const h = harness(async (request, value) => {
      calls.push(request.id);
      signal = value;
      return pending.promise;
    });
    try {
      h.rpc(1);
      h.rpc(2);
      h.rpc(3);
      await flush();
      assert.deepEqual(calls, [1]);
      h.emit({ type: "done" });
      assert.equal((await h.outcome).ok, true);
      assert.equal(signal.aborted, true);
      h.cleaned();
      pending.resolve("too late");
      await flush();
      assert.deepEqual(calls, [1]);
      assert.equal(h.outgoing.filter((message) => message.data.type === "response").length, 0);
    } finally {
      pending.resolve(null);
      h.session.cancel();
      await h.outcome;
    }
    let queuedCalls = 0;
    const beforeFirst = harness(async () => {
      queuedCalls++;
    });
    try {
      beforeFirst.rpc(1);
      beforeFirst.rpc(2);
      beforeFirst.emit({ type: "done" });
      assert.equal((await beforeFirst.outcome).ok, true);
      await flush();
      assert.equal(queuedCalls, 0, "done must prevent even the first queued microtask from starting");
      beforeFirst.cleaned();
    } finally {
      beforeFirst.session.cancel();
      await beforeFirst.outcome;
    }
  });
};
