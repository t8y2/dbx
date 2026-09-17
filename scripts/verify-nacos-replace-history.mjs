import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// Explicitly opt into a local test connection. Never run this against production.
const connectionId = process.env.NACOS_TEST_CONNECTION_ID;
assert(connectionId, "Set NACOS_TEST_CONNECTION_ID to a local Docker Nacos connection");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const frontend = process.env.DBX_TEST_FRONTEND || "http://127.0.0.1:5173";
const backend = process.env.DBX_TEST_BACKEND || "http://127.0.0.1:4225";
assert.equal(new URL(frontend).hostname, "127.0.0.1");
assert.equal(new URL(backend).hostname, "127.0.0.1");
const runId = randomUUID();
const group = `DBX_VERIFY_ONLY_${runId}`;
const oldValue = `mysql-old-${runId}.invalid:3306`;
const newValue = `mysql-new-${runId}.invalid:3306`;
const keys = ["one.yaml", "two.properties"].map(name => ({ namespace: "", group, dataId: `${runId}-${name}` }));
const created = [];
const outputDir = process.env.DBX_TEST_OUTPUT || path.resolve("outputs/nacos-history-verification");
await mkdir(outputDir, { recursive: true });
const metadata = JSON.parse(await readFile("node_modules/.vite/deps/_metadata.json", "utf8"));
const dependencyUrl = name => `/@fs/${path.resolve("node_modules/.vite/deps", metadata.optimized[name].file).replaceAll("\\", "/")}?v=${metadata.browserHash}`;

async function request(endpoint, body) {
  const response = await fetch(`${backend}${endpoint}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  assert(response.ok, `Backend request ${endpoint} failed (${response.status})`);
  return response.json();
}
function checksum() {
  return execFileSync("docker", ["exec", "dbx-nacos-mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --batch --skip-column-names -e "SET SESSION group_concat_max_len=16777216; SELECT COUNT(*), MD5(GROUP_CONCAT(CONCAT(id, CHAR(58), MD5(content)) ORDER BY id)) FROM nacos.config_info;"',
  ], { encoding: "utf8" }).trim();
}
const connections = await request("/api/connection/list");
const connection = connections.find(item => item.id === connectionId);
assert(connection?.db_type === "nacos");
const addr = new URL(connection.external_config.serverAddr);
assert(["host.docker.internal", "127.0.0.1", "localhost", "database"].includes(addr.hostname), "Only local Docker Nacos is allowed");
assert.equal(addr.port, "8848");
const before = checksum();
const browser = await chromium.launch({ headless: true });
try {
  for (const key of keys) {
    await request("/api/nacos/configs/publish", { connectionId, req: { ...key, content: `url=${oldValue}\nreplica=${oldValue}`, configType: "properties" } });
    created.push(key);
  }
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => { pageErrors.push(error.message); console.error("Browser module error:", error.message); });
  page.on("requestfailed", req => console.error("Browser module request failed:", new URL(req.url()).pathname));
  // Mount the real component in an isolated harness without touching user tabs
  // or the normal app's saved connections, layout and editor state.
  await page.route(`${frontend}/`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test-root"></div><script type="module">
    import {createApp,h,ref} from ${JSON.stringify(dependencyUrl("vue"))};
    import {createPinia} from ${JSON.stringify(dependencyUrl("pinia"))};
    import Dialog from '/src/components/nacos/NacosContentReplaceDialog.vue';
    import i18n,{loadLocaleMessages} from '/src/i18n/index.ts';
    import '/src/styles/globals.css';
    await loadLocaleMessages('zh-CN'); i18n.global.locale.value='zh-CN';
    const open=ref(true); window.setTestOpen=value=>open.value=value;
    const app=createApp({setup:()=>()=>h(Dialog,{open:open.value,connectionId:${JSON.stringify(connectionId)},currentNamespace:'','onUpdate:open':value=>open.value=value})});
    app.use(createPinia()); app.use(i18n); app.mount('#test-root'); window.testReady=true;
  </script></body></html>` }));
  await page.route("**/api/nacos/configs/publish", async route => {
    const { req } = route.request().postDataJSON();
    assert(keys.some(key => req.group === key.group && req.dataId === key.dataId && !req.namespace), "Browser tried to publish outside the fixtures");
    assert([`url=${oldValue}\nreplica=${oldValue}`, `url=${newValue}\nreplica=${newValue}`].includes(req.content));
    await route.continue();
  });
  await page.goto(frontend);
  await page.waitForFunction(() => window.testReady, null, { timeout: 60000 });
  await page.getByTestId("nacos-replace-search").fill(oldValue);
  await page.getByTestId("nacos-replace-value").fill(newValue);
  await page.getByTestId("nacos-replace-scope").selectOption("allNamespaces");
  await page.getByTestId("nacos-replace-preview").click();
  await page.getByTestId("nacos-replace-apply").waitFor({ timeout: 60000 });
  await page.getByTestId("nacos-replace-apply").click();
  await page.getByText("成功替换 2 个，冲突 0 个，失败 0 个", { exact: true }).waitFor({ timeout: 60000 });
  for (const key of keys) assert.equal((await request("/api/nacos/configs/get", { connectionId, key })).content, `url=${newValue}\nreplica=${newValue}`);
  await page.evaluate(() => window.setTestOpen(false));
  await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
  await page.evaluate(() => window.setTestOpen(true));
  await page.getByTestId("nacos-replace-history-tab").click();
  await page.getByTestId("nacos-replace-history-details").waitFor();
  await page.reload();
  await page.waitForFunction(() => window.testReady);
  await page.getByTestId("nacos-replace-history-tab").click();
  await page.getByTestId("nacos-replace-history-details").click();
  await page.screenshot({ path: path.join(outputDir, "history-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outputDir, "history-mobile.png") });
  const overflow = await page.locator('[role="dialog"]').evaluate(element => element.scrollWidth > element.clientWidth + 2);
  assert.equal(overflow, false, "History dialog has horizontal overflow on mobile");
  await page.setViewportSize({ width: 1366, height: 900 });
  const secureStorage = await page.evaluate(async ({ connectionId, oldValue, newValue }) => {
    const storage = await import('/src/lib/nacos/nacosReplaceHistoryStorage.ts');
    const entries = await storage.listNacosReplaceHistory(connectionId);
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('dbx-nacos-replace-history', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const get = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const rows = await get(db.transaction('entries').objectStore('entries').getAll());
    const key = await get(db.transaction('keys').objectStore('keys').get('encryption-key'));
    db.close();
    const raw = JSON.stringify(rows);
    const foreign = await storage.getNacosReplaceHistory(entries[0].id, 'other-connection');
    return { count: entries.length, extractable: key.extractable, plaintext: raw.includes(oldValue) || raw.includes(newValue), foreign: !!foreign };
  }, { connectionId, oldValue, newValue });
  assert.deepEqual(secureStorage, { count: 1, extractable: false, plaintext: false, foreign: false });
  await page.getByTestId("nacos-replace-history-rollback").click();
  await page.getByRole("button", { name: "回滚已替换配置", exact: true }).last().waitFor();
  await page.screenshot({ path: path.join(outputDir, "rollback-confirmation.png") });
  assert.equal((await request("/api/nacos/configs/get", { connectionId, key: keys[0] })).content, `url=${newValue}\nreplica=${newValue}`, "Rollback must wait for confirmation");
  await page.getByRole("button", { name: "回滚已替换配置", exact: true }).last().click();
  await page.getByText("回滚结果：已恢复 2 个，冲突 0 个，失败 0 个", { exact: true }).waitFor({ timeout: 60000 });
  for (const key of keys) assert.equal((await request("/api/nacos/configs/get", { connectionId, key })).content, `url=${oldValue}\nreplica=${oldValue}`);
  await page.reload(); await page.waitForFunction(() => window.testReady);
  await page.getByTestId("nacos-replace-history-tab").click();
  await page.getByText("回滚结果：已恢复 2 个，冲突 0 个，失败 0 个", { exact: true }).waitFor();
  await page.getByTestId("nacos-replace-history-details").click();
  assert.equal(await page.getByTestId("nacos-replace-history-rollback").isDisabled(), true);
  assert.deepEqual(pageErrors, []);
  console.log("PASS: real API publish, close/reopen, reload, encrypted IndexedDB, confirmed historical rollback, rollback persistence, desktop/mobile overflow");
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(outputDir, "failure.png") });
  throw error;
} finally {
  await browser.close();
  for (const key of created) await request("/api/nacos/configs/delete", { connectionId, key });
  assert.equal(checksum(), before, "Original Nacos configs changed during verification");
  console.log("PASS: only exact test fixtures removed; original config count/checksum unchanged");
}
