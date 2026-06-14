<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "@lucide/vue";
import type { GeneratorParams } from "@/lib/dataGenerate";
import CommonOptions from "./CommonOptions.vue";

const props = defineProps<{ params: GeneratorParams }>();

const extensionCategoryMap: Record<string, string[]> = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".tiff"],
  document: [".txt", ".pdf", ".doc", ".docx", ".rtf", ".odt"],
  spreadsheet: [".xls", ".xlsx", ".csv", ".ods", ".tsv"],
  presentation: [".ppt", ".pptx", ".odp", ".key"],
  audio: [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"],
  video: [".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv"],
  code: [".js", ".ts", ".py", ".java", ".cpp", ".c", ".h", ".rs", ".go", ".rb", ".php"],
  archive: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"],
  web: [".html", ".htm", ".css", ".json", ".xml", ".yml", ".yaml"],
  database: [".db", ".sqlite", ".sql", ".mdb", ".accdb"],
};

const categoryLabels: Record<string, string> = {
  image: "图像",
  document: "文档",
  spreadsheet: "表格",
  presentation: "演示文稿",
  audio: "音频",
  video: "视频",
  code: "代码",
  archive: "压缩包",
  web: "网页",
  database: "数据库",
};

if (!props.params.pathTypes) {
  props.params.pathTypes = ["windows", "macos", "linux"];
}
if (!props.params.includeFileName) {
  props.params.includeFileName = true;
}
if (!props.params.extensionCategory) {
  props.params.extensionCategory = "image";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateWindowsPath(includeName: boolean, ext: string): string {
  const baseDirs = ["Users", "Program Files", "ProgramData", "Windows", "Temp"];
  const userDirs = ["Administrator", "User", "Admin", "Guest"];
  const folders = ["Documents", "Downloads", "Pictures", "Music", "Videos", "Desktop"];
  const nameBases = ["report", "doc", "img", "photo", "backup", "config", "data", "file"];
  const base = `C:\\${pick(baseDirs)}\\${pick(userDirs)}\\${pick(folders)}`;
  if (!includeName) return base;
  return `${base}\\${pick(nameBases)}_${Math.floor(Math.random() * 999999)}${ext}`;
}

function generateMacPath(includeName: boolean, ext: string): string {
  const users = ["administrator", "user", "admin", "guest"];
  const folders = ["Documents", "Downloads", "Pictures", "Music", "Movies", "Desktop", "Library", "Applications"];
  const nameBases = ["report", "doc", "img", "photo", "backup", "config", "data", "file"];
  const base = `/Users/${pick(users)}/${pick(folders)}`;
  if (!includeName) return base;
  return `${base}/${pick(nameBases)}_${Math.floor(Math.random() * 999999)}${ext}`;
}

function generateLinuxPath(includeName: boolean, ext: string): string {
  const baseDirs = ["home", "opt", "var", "usr", "tmp", "root"];
  const users = ["user", "admin", "root", "ubuntu", "deploy"];
  const folders = ["documents", "downloads", "pictures", "music", "videos", "projects", "data", "logs"];
  const nameBases = ["report", "doc", "img", "photo", "backup", "config", "data", "file"];
  const base = baseDirs[0] === "home" || pick(baseDirs) === "home" ? `/home/${pick(users)}/${pick(folders)}` : `/${pick(baseDirs)}/${pick(folders)}`;
  if (!includeName) return base;
  return `${base}/${pick(nameBases)}_${Math.floor(Math.random() * 999999)}${ext}`;
}

const previewKey = ref(0);
const previewVal = computed(() => {
  void previewKey.value;
  const exts = extensionCategoryMap[props.params.extensionCategory ?? "image"] ?? extensionCategoryMap.image;
  const ext = pick(exts);
  const types = props.params.pathTypes?.length ? props.params.pathTypes : ["linux"];
  const t = pick(types);
  const includeName = props.params.includeFileName ?? true;
  if (t === "windows") return generateWindowsPath(includeName, ext);
  if (t === "macos") return generateMacPath(includeName, ext);
  return generateLinuxPath(includeName, ext);
});

function togglePathType(val: string) {
  if (!props.params.pathTypes) props.params.pathTypes = [];
  const idx = props.params.pathTypes.indexOf(val);
  if (idx >= 0) props.params.pathTypes.splice(idx, 1);
  else props.params.pathTypes.push(val);
}

function refresh() {
  previewKey.value++;
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">路径类型</div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="pt in [
            { value: 'windows', label: 'Windows' },
            { value: 'macos', label: 'macOS' },
            { value: 'linux', label: 'Linux' },
          ]"
          :key="pt.value"
          type="button"
          class="px-2 py-1 rounded border text-xs"
          :class="(params.pathTypes || []).includes(pt.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'"
          @click="togglePathType(pt.value)"
        >
          {{ pt.label }}
        </button>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <label class="text-xs text-muted-foreground flex items-center gap-2">
        <input type="checkbox" v-model="params.includeFileName" class="rounded" />
        包含文件名称
      </label>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">扩展名类型</div>
      <select v-model="params.extensionCategory" class="w-full rounded border bg-background px-2 py-1 text-xs">
        <option v-for="(label, key) in categoryLabels" :key="key" :value="key">{{ label }}</option>
      </select>
      <div class="mt-2 text-xs text-muted-foreground">可用扩展名：</div>
      <div class="mt-1 flex flex-wrap gap-1">
        <span v-for="ext in extensionCategoryMap[params.extensionCategory || 'image'] || []" :key="ext" class="px-1.5 py-0.5 rounded bg-background border text-xs font-mono">{{ ext }}</span>
      </div>
    </div>
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0">预览</span>
        <span :key="previewKey" class="font-mono text-sm break-all">{{ previewVal }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 ml-auto" @click="refresh">
          <RefreshCw class="h-3 w-3" />
        </Button>
      </div>
    </div>
    <CommonOptions :params="params" />
  </div>
</template>
