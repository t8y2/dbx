import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

function functionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const asyncSignature = `async ${signature}`;
  const signatureIndex = source.indexOf(asyncSignature) >= 0 ? source.indexOf(asyncSignature) : source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}

// issue #9035：打开对象源码必须「先出 UI 再加载」。加载态要有可见落点
// （tab 栏 + tab 内容区）、失败要能就地重试、连接建立也要罩在弹窗的加载态之内。
test("object source loading feedback is visible in the tab bar and the tab body", () => {
  const contentArea = read("apps/desktop/src/components/layout/ContentArea.vue");
  const tabStatus = read("apps/desktop/src/components/layout/TabExecutionStatus.vue");

  assert.match(contentArea, /activeTab\.sourceLoad && !activeTab\.sourceLoad\.error/);
  assert.match(contentArea, /:elapsed-seconds="sourceLoadElapsedSeconds"/);
  assert.match(contentArea, /data-object-source-load-error/);
  assert.match(contentArea, /queryStore\.retryObjectSourceTab\(activeTab\.id\)/);

  assert.match(tabStatus, /props\.tab\.sourceLoad && !props\.tab\.sourceLoad\.error/);
  // 失败态由内容区的错误 + Retry 表达，tab 栏不应继续转圈
  assert.match(tabStatus, /labelKey/);
});

test("the object source dialog owns the connection it waits for", () => {
  const dialog = read("apps/desktop/src/components/objects/ObjectSourceDialog.vue");
  const loadBody = functionBody(dialog, "loadSource");

  // 调用方不再先 await ensureConnected 才开弹窗，连接必须发生在弹窗的 loading 之内
  const connectIndex = loadBody.indexOf("ensureConnected");
  const fetchIndex = loadBody.indexOf("loadObjectSourceWithRoutineFallback");
  assert.ok(connectIndex >= 0, "ObjectSourceDialog.loadSource must own ensureConnected");
  assert.ok(fetchIndex >= 0, "ObjectSourceDialog.loadSource must fetch the source");
  assert.ok(connectIndex < fetchIndex, "connect must happen before the source fetch");
});

test("query-tab entry no longer blocks the sidebar on connect", () => {
  const connectionTree = read("apps/desktop/src/components/sidebar/ConnectionTree.vue");
  const openBody = functionBody(connectionTree, "openSidebarObjectSource");

  // 弹窗立即挂载；此前的 await ensureConnected 制造了没有反馈的死等窗口
  // （断言调用形态，注释里提到这个名字不算）
  assert.doesNotMatch(openBody, /ensureConnected\(/);
  assert.match(openBody, /sidebarObjectSourceOpen\.value = true/);
});

test("query-editor object source entry uses the same visible loading path", () => {
  const app = read("apps/desktop/src/App.vue");
  const openBody = functionBody(app, "onOpenObjectSource");

  assert.match(openBody, /queryStore\.openObjectSourceTabPending\(\{/);
  assert.match(openBody, /queryEditorObjectSourceTarget\.value =/);
  assert.match(openBody, /showQueryEditorObjectSourceDialog\.value = true/);
  assert.doesNotMatch(openBody, /ensureConnected\(/);
  assert.doesNotMatch(openBody, /api\.getObjectSource\(/);
});

test("object source load state is runtime-only and never restored from disk", () => {
  const persistence = read("apps/desktop/src/lib/app/openTabsPersistence.ts");
  const types = read("apps/desktop/src/types/database.ts");
  const serializeBody = functionBody(persistence, "serializeOpenTabs");

  // tab 类型上带着重试所需的请求身份
  assert.match(types, /sourceLoad\?: \{/);
  assert.match(types, /request: \{\n\s+name: string;\n\s+objectType: ObjectSourceKind;/);
  // 不落盘：否则重启后 tab 会永久停在「加载中」
  assert.doesNotMatch(serializeBody, /sourceLoad/);
  assert.match(persistence, /sourceLoad: undefined/);
});
