<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Plus, Upload, Plug, Unplug, Pencil, Trash2, X, RefreshCw, Sun, Moon, Terminal, Settings2, Languages } from "lucide-vue-next";
import { hostMessage } from "./messages.js";
import DebugPanel from "./DebugPanel.vue";
import { localizeManifest, translate } from "./i18n.js";
const rawManifest = ref(),
  connections = ref([]),
  frames = ref([]),
  active = ref(""),
  state = ref("starting");
const error = ref(""),
  notice = ref(""),
  busy = ref(false),
  rebuilt = ref(false),
  dark = ref(false);
const debugOpen = ref(false),
  diagnostics = ref([]);
const locale = ref("zh-CN");
const pageId = crypto.randomUUID();
const t = (text, values) => translate(locale.value, text, values);
const manifest = computed(() => localizeManifest(rawManifest.value ? JSON.parse(JSON.stringify(rawManifest.value)) : undefined, locale.value));
const frameName = (frame) => (frame.connectionId ? frame.name : manifest.value?.contributions.find((c) => c.id === frame.contributionId)?.label || frame.name);
watch(
  locale,
  (value) => {
    window.document.documentElement.lang = value;
    window.document.title = t("插件调试");
  },
  { immediate: true },
);
const autoReload = ref(false),
  pendingReload = ref(false);
async function toggleAutoReload(event) {
  event.target.checked = autoReload.value;
  await run(async () => {
    if (!autoReload.value && !(await ask("启用自动重载？所有打开的插件页面会在更新后刷新，未保存修改将丢失；后端源码变化会重建并断开连接。此设置影响同一调试服务的所有浏览器页面。"))) return;
    autoReload.value = (await api("auto-reload", { enabled: !autoReload.value })).enabled;
  });
}
watch([busy, autoReload, pendingReload], async () => {
  if (!autoReload.value) {
    pendingReload.value = false;
    return;
  }
  if (busy.value || !pendingReload.value) return;
  pendingReload.value = false;
  await run(async () => {
    for (const frame of frames.value) Object.assign(frame, await api("frame-document", { frameId: frame.id }));
    rebuilt.value = false;
  });
});
async function changeLocale() {
  await run(async () => {
    const current = frames.value.find((frame) => frame.id === active.value);
    if (current && !(await ask("切换语言并重载当前页面？未保存修改将丢失。"))) return;
    const document = current ? await api("frame-document", { frameId: current.id }) : undefined;
    locale.value = locale.value === "zh-CN" ? "en" : "zh-CN";
    for (const frame of frames.value) post(frame, { type: "env", locale: locale.value });
    if (current) {
      Object.assign(current, document);
      rebuilt.value = false;
    }
  });
}
function mergeDiagnostics(entries) {
  diagnostics.value = [...new Map([...diagnostics.value, ...entries].map((e) => [e.id, e])).values()].sort((a, b) => a.id - b.id).slice(-500);
}
const editor = ref(),
  askDialog = ref(),
  importing = ref(),
  question = ref(""),
  draft = ref(),
  editing = ref(false);
const windows = new Map();
let csrf, stream, finishAsk;
const providers = computed(() => manifest.value?.contributions.filter((c) => c.type === "connection-provider") || []);
const workbenches = computed(() => manifest.value?.contributions.filter((c) => c.type === "workbench") || []);
const provider = computed(() => providers.value.find((p) => p.id === draft.value?.providerId));
const themes = () => ({
  appearance: dark.value ? "dark" : "light",
  tokens: dark.value
    ? {
        "--color-background": "#18181b",
        "--color-foreground": "#f4f4f5",
        "--color-muted": "#27272a",
        "--color-border": "#3f3f46",
        "--color-primary": "#60a5fa",
      }
    : { "--color-background": "#ffffff", "--color-foreground": "#27272a", "--color-muted": "#f4f4f5", "--color-border": "#e4e4e7", "--color-primary": "#2563eb" },
});
function post(frame, message) {
  const snapshot = hostMessage(frame.channel, message);
  windows.get(frame.id)?.contentWindow?.postMessage(snapshot, "*");
}
function init(frame) {
  post(frame, { type: "init", context: JSON.parse(JSON.stringify(frame.context)), locale: locale.value, theme: themes(), permissions: manifest.value.permissions || [] });
}
function theme() {
  dark.value = !dark.value;
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
  for (const f of frames.value) post(f, { type: "env", theme: themes() });
}
async function api(path, params = {}) {
  const response = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Mock-Csrf": csrf, "X-DBX-Page": pageId }, body: JSON.stringify(params) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message || "请求失败"), { code: result.error?.code, data: result.error?.data });
  return result.value;
}
async function run(action) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function ask(message) {
  question.value = message;
  const promise = new Promise((resolve) => {
    finishAsk = resolve;
  });
  await nextTick();
  askDialog.value.showModal();
  return promise;
}
function answer(yes) {
  askDialog.value.close();
  finishAsk?.(yes);
  finishAsk = undefined;
}
async function bootstrap() {
  const response = await fetch("/api/bootstrap");
  if (!response.ok) throw new Error("无法读取模拟宿主状态");
  const data = await response.json();
  csrf = data.csrf;
  rawManifest.value = data.manifest;
  connections.value = data.connections;
  state.value = data.state;
  diagnostics.value = data.diagnostics || [];
  autoReload.value = data.autoReload || false;
}
function newDraft() {
  draft.value = { providerId: providers.value[0]?.id, values: {}, readOnly: false };
  editing.value = false;
  defaults();
  editor.value.showModal();
}
function defaults() {
  draft.value.values = Object.fromEntries((provider.value?.fields || []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
}
async function edit(record) {
  await run(async () => {
    draft.value = await api("connections/edit", { id: record.id });
    editing.value = true;
    editor.value.showModal();
  });
}
async function save() {
  await run(async () => {
    const result = await api("connections/save", draft.value);
    connections.value = result.connections;
    for (const f of frames.value) if (f.connectionId === result.id) f.name = result.connections.find((c) => c.id === result.id)?.name || f.name;
    editor.value.close();
    draft.value = undefined;
    notice.value = "连接已保存";
  });
}
async function test() {
  await run(async () => {
    await api("connections/test", draft.value);
    notice.value = "连接测试成功";
  });
}
async function addFrame(frame) {
  const previous = frames.value.find((f) => f.id === frame.id);
  if (previous) {
    previous.context = frame.context;
    previous.name = frame.name;
    post(previous, { type: "context", context: frame.context });
  } else {
    const document = await api("frame-document", { frameId: frame.id });
    frames.value.push(document);
  }
  active.value = frame.id;
}
async function connect(record) {
  await run(async () => {
    const result = await api("connections/connect", { id: record.id });
    connections.value = result.connections;
    await addFrame(result.frame);
  });
}
async function openWorkbench(contribution) {
  await run(async () => {
    await addFrame((await api("workbenches/open", { contributionId: contribution.id })).frame);
  });
}
async function disconnect(record) {
  await run(async () => {
    if (!(await ask("断开连接将中断该连接正在进行的操作。继续？"))) return;
    connections.value = (await api("connections/disconnect", { id: record.id })).connections;
  });
}
async function remove(record) {
  await run(async () => {
    if (!(await ask(t("删除连接“{name}”？其页面将关闭，未保存修改会丢失。", { name: record.name })))) return;
    connections.value = (await api("connections/delete", { id: record.id })).connections;
    removeFrames(record.id);
  });
}
function removeFrames(connectionId) {
  for (const f of frames.value.filter((f) => f.connectionId === connectionId)) windows.delete(f.id);
  frames.value = frames.value.filter((f) => f.connectionId !== connectionId);
  if (!frames.value.some((f) => f.id === active.value)) active.value = frames.value[0]?.id || "";
}
async function closeFrame(frame) {
  await run(async () => {
    if (!(await ask("关闭此页面？未保存修改将丢失；最后一个关联页面关闭后会断开连接。"))) return;
    connections.value = (await api("frames/close", { id: frame.id })).connections;
    windows.delete(frame.id);
    frames.value = frames.value.filter((f) => f.id !== frame.id);
    if (active.value === frame.id) active.value = frames.value[0]?.id || "";
  });
}
async function reload() {
  await run(async () => {
    const f = frames.value.find((f) => f.id === active.value);
    if (!f) return;
    if (!(await ask("重载当前页面？未保存修改将丢失。"))) return;
    const document = await api("frame-document", { frameId: f.id });
    Object.assign(f, document);
    rebuilt.value = false;
  });
}
async function restart() {
  await run(async () => {
    if (!(await ask("重建并重启后端将断开所有连接、中断传输。页面不会自动重载，写操作不会自动重试。继续？"))) return;
    state.value = "building";
    const result = await api("backend/restart");
    connections.value = result.connections;
    state.value = result.state;
    notice.value = "后端已启动，请重新连接";
  });
}
async function importFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  await run(async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error("导入文件超过 2 MiB");
    const data = JSON.parse(await file.text());
    connections.value = (await api("connections/import", data)).connections;
  });
  event.target.value = "";
}
async function onMessage(event) {
  const m = event.data;
  const f = frames.value.find((f) => windows.get(f.id)?.contentWindow === event.source);
  if (!f || m?.source !== "dbx-plugin" || m.version !== 1 || m.channel !== f.channel) return;
  if (m.type === "ready") {
    init(f);
    return;
  }
  if (m.type !== "request") return;
  const channel = f.channel;
  try {
    const result = await api("bridge", { frameId: f.id, channel, method: m.method, params: m.params });
    if (f.channel !== channel || !windows.has(f.id)) return;
    if (m.method === "host.openWorkbench" && result?.mockHostOpenFrame) {
      await addFrame(result.mockHostOpenFrame);
      post(f, { type: "response", id: m.id, result: null });
    } else post(f, { type: "response", id: m.id, result });
  } catch (e) {
    if (f.channel === channel) post(f, { type: "response", id: m.id, error: { message: e.message, code: e.code, data: e.data } });
  }
}
onMounted(async () => {
  window.addEventListener("message", onMessage);
  await run(async () => {
    await bootstrap();
    stream = new EventSource(`/api/events?page=${pageId}`);
    stream.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.type === "connections") connections.value = m.connections;
      if (m.type === "page-frames") {
        for (const f of frames.value) if (!m.ids.includes(f.id)) windows.delete(f.id);
        frames.value = frames.value.filter((f) => m.ids.includes(f.id));
        if (!frames.value.some((f) => f.id === active.value)) active.value = frames.value[0]?.id || "";
      }
      if (m.type === "diagnostic") mergeDiagnostics([m.entry]);
      if (m.type === "diagnostic-history") mergeDiagnostics(m.entries);
      if (m.type === "status") {
        state.value = m.state;
        if (m.state !== "ready") connections.value = connections.value.map((c) => ({ ...c, connected: false }));
      }
      if (m.type === "ui-rebuilt") {
        rebuilt.value = true;
        if (autoReload.value) pendingReload.value = true;
      }
      if (m.type === "auto-reload") autoReload.value = m.enabled;
      if (m.type === "auto-reload-error") error.value = "自动重载失败，请查看调试日志；修复源码后可重试";
      if (m.type === "frames-removed") removeFrames(m.connectionId);
      if (m.type === "watch-error") error.value = "页面构建监听已停止，请重启调试服务";
      if (m.type === "event" || m.type === "binary") for (const f of frames.value) post(f, { ...m, binaryChannel: m.channel });
    };
    stream.onerror = () => {
      error.value = "调试服务连接中断，正在重新连接";
    };
  });
});
onBeforeUnmount(() => {
  stream?.close();
  window.removeEventListener("message", onMessage);
});
</script>

<template>
  <main class="flex h-full flex-col bg-base-100 text-base-content">
    <header class="flex min-h-14 flex-wrap items-center gap-3 border-b border-base-300 px-4 py-2">
      <Terminal :size="20" class="text-success" />
      <h1 class="text-sm font-semibold">{{ t("插件调试") }}</h1>
      <span class="mr-auto text-xs text-base-content/60">{{ manifest?.name }}</span>
      <span class="text-xs" :class="['ready', 'frontend'].includes(state) ? 'text-success' : 'text-warning'" role="status">{{
        t({ frontend: "纯前端", ready: "后端运行中", building: "正在构建", starting: "正在启动", stopped: "后端已停止", stopping: "正在停止", failed: "后端异常" }[state] || state)
      }}</span>
      <button v-if="manifest?.entrypoints?.backend" class="btn btn-sm" :disabled="busy" @click="restart"><RefreshCw :size="14" />{{ t("重建后端") }}</button>
      <button class="btn btn-sm shrink-0" :class="rebuilt ? 'text-info' : ''" :disabled="busy || !active" @click="reload"><RefreshCw :size="14" />{{ t(rebuilt ? "有新构建 · 重载页面" : "重载页面") }}</button>
      <button class="btn btn-sm w-28 shrink-0" :disabled="busy" :aria-label="t('切换插件语言')" :title="t('切换插件语言')" @click="changeLocale"><Languages :size="14" />{{ t(locale === "zh-CN" ? "中文" : "English") }}</button>
      <button class="btn btn-sm" :class="debugOpen ? 'btn-active' : ''" :aria-expanded="debugOpen" aria-controls="debug-panel" @click="debugOpen = !debugOpen"><Terminal :size="14" />{{ t("调试") }}</button>
      <label class="flex shrink-0 items-center gap-2 text-xs"><input type="checkbox" class="toggle toggle-xs" :aria-label="t('自动重载')" :checked="autoReload" :disabled="busy" @change="toggleAutoReload" />{{ t("自动重载") }}</label>
      <button class="btn btn-sm btn-square btn-ghost" :aria-label="t(dark ? '浅色主题' : '深色主题')" :title="t(dark ? '浅色主题' : '深色主题')" @click="theme"><Sun v-if="dark" :size="16" /><Moon v-else :size="16" /></button>
    </header>
    <div v-if="error && !draft" role="alert" class="flex gap-2 border-b border-error/30 bg-error/10 px-4 py-2 text-sm text-error">
      <span class="min-w-0 flex-1 break-words">{{ t(error) }}</span
      ><button class="btn btn-xs btn-square btn-ghost" :aria-label="t('关闭错误')" @click="error = ''"><X :size="14" /></button>
    </div>
    <div v-if="notice && !draft" role="status" class="border-b border-base-300 px-4 py-2 text-xs text-success">{{ t(notice) }}</div>
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-56 shrink-0 flex-col border-r border-base-300 bg-base-200 max-sm:w-40" :aria-label="t('连接列表')">
        <div v-if="workbenches.length" class="border-b border-base-300 p-2">
          <h2 class="px-1 py-2 text-xs font-semibold">{{ t("工作台") }}</h2>
          <button v-for="workbench in workbenches" :key="workbench.id" class="btn btn-sm btn-ghost w-full justify-start" :title="workbench.label" :disabled="busy" @click="openWorkbench(workbench)">
            <Terminal :size="14" /><span class="truncate">{{ workbench.label }}</span>
          </button>
        </div>
        <div class="flex items-center gap-1 border-b border-base-300 p-2">
          <h2 class="mr-auto text-xs font-semibold">{{ t("连接") }}</h2>
          <button class="btn btn-sm btn-square btn-ghost" :aria-label="t('新建连接')" :title="t('新建连接')" :disabled="busy || !providers.length" @click="newDraft"><Plus :size="16" /></button
          ><button class="btn btn-sm btn-square btn-ghost" :aria-label="t('导入连接')" :title="t('导入连接')" :disabled="busy" @click="importing.click()"><Upload :size="16" /></button><input ref="importing" type="file" accept="application/json,.json" hidden @change="importFile" />
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-2">
          <div v-for="c in connections" :key="c.id" class="mb-1 border-b border-base-300 pb-2" :data-connection="c.id">
            <button class="flex w-full min-w-0 items-center gap-2 py-2 text-left text-sm" :title="c.name" :disabled="busy || state !== 'ready'" @click="connect(c)">
              <Plug :size="15" class="shrink-0" :class="c.connected ? 'text-success' : 'text-base-content/40'" /><span class="truncate">{{ c.name }}</span>
            </button>
            <div class="flex items-center gap-1">
              <span class="mr-auto truncate text-xs text-base-content/60">{{ providers.find((p) => p.id === c.providerId)?.label || c.label }}</span
              ><button class="btn btn-xs btn-square btn-ghost" :aria-label="t('编辑') + ' ' + c.name" :title="t('编辑')" :disabled="busy" @click="edit(c)"><Pencil :size="13" /></button
              ><button class="btn btn-xs btn-square btn-ghost" :aria-label="t('断开') + ' ' + c.name" :title="t('断开')" :disabled="busy || !c.connected" @click="disconnect(c)"><Unplug :size="13" /></button
              ><button class="btn btn-xs btn-square btn-ghost" :aria-label="t('删除') + ' ' + c.name" :title="t('删除')" :disabled="busy" @click="remove(c)"><Trash2 :size="13" /></button>
            </div>
          </div>
          <p v-if="!connections.length" class="py-8 text-center text-xs text-base-content/50">{{ t("暂无连接") }}</p>
        </div>
      </aside>
      <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="t('工作台')">
        <div class="flex min-h-10 items-center border-b border-base-300">
          <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
            <div v-for="f in frames" :key="f.id" class="flex shrink-0 items-center border-r border-base-300" :class="active === f.id ? 'bg-base-200 border-b-2 border-b-info' : ''">
              <button role="tab" class="max-w-44 truncate px-3 py-2 text-xs" :aria-selected="active === f.id" :title="frameName(f)" @click="active = f.id">{{ frameName(f) }}</button
              ><button class="btn btn-xs btn-square btn-ghost mr-1" :aria-label="t('关闭') + ' ' + frameName(f)" :disabled="busy" @click="closeFrame(f)"><X :size="12" /></button>
            </div>
          </div>
        </div>
        <div class="relative min-h-0 flex-1">
          <iframe v-for="f in frames" v-show="active === f.id" :key="f.id" :ref="(el) => (el ? windows.set(f.id, el) : windows.delete(f.id))" :srcdoc="f.html" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="frameName(f)" class="absolute inset-0" @load="init(f)" />
          <div v-if="!frames.length" class="grid h-full place-items-center text-sm text-base-content/50">
            <div class="flex items-center gap-2"><Settings2 :size="18" />{{ t("尚未打开工作台") }}</div>
          </div>
        </div>
      </section>
    </div>
    <DebugPanel v-if="debugOpen" :entries="diagnostics" :locale="locale" @close="debugOpen = false" />
    <dialog ref="editor" class="modal" @cancel="draft = undefined">
      <form v-if="draft" class="modal-box max-w-xl rounded-lg" @submit.prevent="save">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-semibold">{{ t(editing ? "编辑连接" : "新建连接") }}</h2>
          <button
            type="button"
            class="btn btn-sm btn-square btn-ghost"
            :aria-label="t('关闭表单')"
            :disabled="busy"
            @click="
              editor.close();
              draft = undefined;
            "
          >
            <X :size="16" />
          </button>
        </div>
        <label class="mt-4 block text-xs"
          >{{ t("连接类型")
          }}<select v-model="draft.providerId" class="select select-sm mt-1 w-full" :disabled="editing || busy" @change="defaults">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select></label
        >
        <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label v-for="field in provider?.fields || []" :key="field.key" class="min-w-0 text-xs" :class="field.type === 'textarea' ? 'sm:col-span-2' : ''"
            >{{ field.label }}{{ field.required ? " *" : "" }}
            <select v-if="field.type === 'select'" v-model="draft.values[field.key]" class="select select-sm mt-1 w-full" :aria-label="field.label" :required="field.required" :disabled="busy">
              <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <div v-else-if="field.type === 'radio'" class="mt-2 flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" :aria-label="field.label">
              <label v-for="option in field.options" :key="option.value" class="flex items-center gap-2">
                <input v-model="draft.values[field.key]" type="radio" :name="field.key" :value="option.value" :disabled="busy" />
                <span>{{ option.label }}</span>
              </label>
            </div>
            <input v-else-if="field.type === 'boolean'" v-model="draft.values[field.key]" type="checkbox" class="checkbox checkbox-sm ml-2" :aria-label="field.label" :disabled="busy" />
            <textarea v-else-if="field.type === 'textarea'" v-model="draft.values[field.key]" class="textarea mt-1 w-full" :aria-label="field.label" :required="field.required" :disabled="busy" />
            <input v-else-if="field.type === 'number'" v-model.number="draft.values[field.key]" type="number" class="input input-sm mt-1 w-full" :aria-label="field.label" :required="field.required" :disabled="busy" />
            <input v-else v-model="draft.values[field.key]" :type="field.type === 'password' ? 'password' : 'text'" class="input input-sm mt-1 w-full" :aria-label="field.label" :required="field.required" :disabled="busy" autocomplete="off" />
            <span v-if="field.description" class="mt-1 block text-xs text-base-content/50">{{ field.description }}</span>
          </label>
        </div>
        <label class="mt-4 flex items-center gap-2 text-xs"><input v-model="draft.readOnly" type="checkbox" class="checkbox checkbox-sm" :disabled="busy" />{{ t("只读连接") }}</label>
        <p v-if="error" role="alert" class="mt-3 break-words text-sm text-error">{{ t(error) }}</p>
        <p v-if="notice" role="status" class="mt-3 text-sm text-success">{{ t(notice) }}</p>
        <div class="modal-action">
          <button type="button" class="btn btn-sm" :disabled="busy || state !== 'ready' || !provider?.capabilities?.includes('test')" @click="test">{{ t("测试连接") }}</button><button class="btn btn-sm" :disabled="busy">{{ t("保存") }}</button>
        </div>
      </form>
    </dialog>
    <dialog ref="askDialog" class="modal" @cancel.prevent="answer(false)">
      <div class="modal-box max-w-sm rounded-lg">
        <p class="text-sm">{{ t(question) }}</p>
        <div class="modal-action">
          <button class="btn btn-sm" @click="answer(false)">{{ t("取消") }}</button><button class="btn btn-sm" @click="answer(true)">{{ t("确认") }}</button>
        </div>
      </div>
    </dialog>
  </main>
</template>
