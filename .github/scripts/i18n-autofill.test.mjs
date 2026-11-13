import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY = "test-key";
process.env.I18N_MOCK_TRANSLATIONS = "0";

const { translateMissing } = await import("./i18n-autofill.mjs");

function translationsResponse(translations) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: JSON.stringify({ translations }) } }] };
    },
    async text() {
      return "";
    },
  };
}

// The shape DeepSeek actually returned for the 16-key es request: a JSON object
// cut off in the middle of a string.
function truncatedResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: '{"translations":{"objects.a":"Motor de' } }] };
    },
    async text() {
      return "";
    },
  };
}

function failingResponse(status) {
  return {
    ok: false,
    status,
    async json() {
      throw new Error("not called");
    },
    async text() {
      return "boom";
    },
  };
}

function installFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const items = JSON.parse(body.messages[1].content).items;
    const keys = items.map((item) => item.key);
    calls.push({ url, keys, maxTokens: body.max_tokens });
    return handler(keys, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function sourceLeaves(entries) {
  return new Map(entries);
}

test("keeps a single request when the answer is usable", async () => {
  const keys = ["objects.a", "objects.b", "objects.c", "objects.d"];
  const stub = installFetch((requested) => translationsResponse(Object.fromEntries(requested.map((key) => [key, `t:${key}`]))));

  try {
    const result = await translateMissing("es", keys, sourceLeaves(keys.map((key) => [key, "中文"])));

    assert.deepEqual(
      stub.calls.map((call) => call.keys),
      [keys],
    );
    assert.deepEqual(result, Object.fromEntries(keys.map((key) => [key, `t:${key}`])));
  } finally {
    stub.restore();
  }
});

test("halves the batch when the JSON answer is truncated", async () => {
  const keys = ["objects.a", "objects.b", "objects.c", "objects.d"];
  const stub = installFetch((requested, attempt) => (attempt === 1 ? truncatedResponse() : translationsResponse(Object.fromEntries(requested.map((key) => [key, `t:${key}`])))));

  try {
    const result = await translateMissing("es", keys, sourceLeaves(keys.map((key) => [key, "中文"])));

    assert.deepEqual(
      stub.calls.map((call) => call.keys),
      [keys, ["objects.a", "objects.b"], ["objects.c", "objects.d"]],
    );
    assert.deepEqual(Object.keys(result).sort(), keys);
    assert.equal(result["objects.c"], "t:objects.c");
  } finally {
    stub.restore();
  }
});

test("halves the batch when a placeholder drifts, down to single keys", async () => {
  const keys = ["objects.a", "objects.b"];
  const leaves = sourceLeaves([
    ["objects.a", "将表 {name} 的引擎改为 {engine}"],
    ["objects.b", "已改为 {engine}"],
  ]);
  const stub = installFetch((requested) =>
    // The batched answer drops the placeholders; only the single-key retries keep them.
    translationsResponse(Object.fromEntries(requested.map((key) => [key, requested.length === 1 && key === "objects.a" ? "将表 {name} 的引擎改为 {engine}" : "已改为 {engine}"]))),
  );

  try {
    const result = await translateMissing("es", keys, leaves);

    assert.deepEqual(
      stub.calls.map((call) => call.keys),
      [keys, ["objects.a"], ["objects.b"]],
    );
    assert.deepEqual(result, { "objects.a": "将表 {name} 的引擎改为 {engine}", "objects.b": "已改为 {engine}" });
  } finally {
    stub.restore();
  }
});

test("does not split transport failures into more requests", async () => {
  const keys = ["objects.a", "objects.b", "objects.c", "objects.d"];
  const stub = installFetch(() => failingResponse(500));

  try {
    await assert.rejects(translateMissing("es", keys, sourceLeaves(keys.map((key) => [key, "中文"]))), /HTTP 500 boom/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("gives up when a single key still comes back unusable", async () => {
  const keys = ["objects.a", "objects.b"];
  const stub = installFetch(() => truncatedResponse());

  try {
    await assert.rejects(translateMissing("es", keys, sourceLeaves(keys.map((key) => [key, "中文"]))), /Unable to parse DeepSeek JSON response/);
    // The first half already exhausts the split, so the second half is never requested.
    assert.deepEqual(
      stub.calls.map((call) => call.keys),
      [keys, ["objects.a"]],
    );
  } finally {
    stub.restore();
  }
});
