<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Sparkles, Copy, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";

/**
 * 保存后数据库报回的编译错误。Oracle 会接受 DDL 再把对象标成 INVALID，错误带着行列号，
 * 以前只拼成一行 toast 闪过去。这里把它们列出来：点一条跳到出错行，右键交给 AI 修。
 */
const props = defineProps<{
  messages: { attribute: string; line: number; position: number; text: string }[];
  objectName: string;
}>();
const emit = defineEmits<{
  /** 跳到出错位置；行列都是 1-based，和 Oracle 的报法一致。 */
  navigate: [position: { line: number; column: number }];
  fixWithAi: [instruction: string];
  dismiss: [];
}>();

const { t } = useI18n();
const expanded = ref(true);
const menu = ref<{ x: number; y: number; index: number } | null>(null);

// ERROR 先于 WARNING，其余按出现位置；同一次编译里错误往往比警告更该先看。
const ordered = computed(() =>
  [...props.messages]
    .map((message, index) => ({ ...message, index }))
    .sort((left, right) => {
      const severity = Number(right.attribute.toUpperCase() === "ERROR") - Number(left.attribute.toUpperCase() === "ERROR");
      return severity || left.line - right.line || left.position - right.position;
    }),
);
const errorCount = computed(() => props.messages.filter((message) => message.attribute.toUpperCase() === "ERROR").length);

function describe(message: { attribute: string; line: number; position: number; text: string }): string {
  return `${props.objectName} ${message.line}:${message.position} ${message.attribute} ${message.text}`;
}

function openMenu(event: MouseEvent, index: number) {
  menu.value = { x: event.clientX, y: event.clientY, index };
}

function fixWithAi(index: number) {
  const message = props.messages[index];
  menu.value = null;
  if (message) emit("fixWithAi", describe(message));
}

async function copyMessage(index: number) {
  const message = props.messages[index];
  menu.value = null;
  if (!message) return;
  try {
    await navigator.clipboard.writeText(describe(message));
  } catch {
    /* Clipboard access can be denied; the text stays visible in the list. */
  }
}
</script>

<template>
  <aside v-if="messages.length" class="flex max-h-48 shrink-0 flex-col border-t bg-destructive/5" data-object-source-compile-errors>
    <div class="flex h-7 shrink-0 items-center gap-1.5 px-2">
      <AlertCircle class="size-3.5 shrink-0 text-destructive" />
      <button type="button" class="min-w-0 flex-1 truncate text-left text-xs font-medium" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ t("objects.compileErrorsTitle", { count: errorCount || messages.length }) }}
      </button>
      <Button variant="ghost" size="icon" class="size-5 shrink-0" :title="t('common.close')" :aria-label="t('common.close')" @click="emit('dismiss')">
        <X class="size-3.5" />
      </Button>
    </div>
    <ul v-show="expanded" class="min-h-0 overflow-auto px-1 pb-1">
      <li v-for="message in ordered" :key="`${message.index}`">
        <button
          type="button"
          class="flex w-full min-w-0 items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          :title="t('objects.compileErrorGoTo', { line: message.line, column: message.position })"
          @click="emit('navigate', { line: message.line, column: message.position })"
          @contextmenu.prevent="openMenu($event, message.index)"
        >
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ message.line }}:{{ message.position }}</span>
          <span class="shrink-0 font-medium" :class="message.attribute.toUpperCase() === 'ERROR' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'">{{ message.attribute }}</span>
          <span class="min-w-0 flex-1 break-words">{{ message.text }}</span>
        </button>
      </li>
    </ul>
    <div v-if="menu" class="fixed inset-0 z-50" @click="menu = null" @contextmenu.prevent="menu = null">
      <div class="absolute min-w-40 rounded-md border bg-popover p-1 shadow-md" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
        <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" @click="fixWithAi(menu.index)">
          <Sparkles class="size-3.5" />
          {{ t("objects.compileErrorFixWithAi") }}
        </button>
        <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" @click="copyMessage(menu.index)">
          <Copy class="size-3.5" />
          {{ t("objects.compileErrorCopy") }}
        </button>
      </div>
    </div>
  </aside>
</template>
