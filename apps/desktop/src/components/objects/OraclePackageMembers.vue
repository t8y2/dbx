<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { refDebounced } from "@vueuse/core";
import { PanelLeftClose, PanelLeftOpen } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { oraclePackageMemberEntries } from "@/lib/sql/oraclePackageMembers";

const props = defineProps<{ source: string }>();
const emit = defineEmits<{ navigate: [offset: number] }>();
const { t } = useI18n();
const listId = useId();
const expanded = ref(true);
// CodeMirror stores line breaks as single characters.
const editorSource = computed(() => (props.source.includes("\r") ? props.source.replace(/\r\n?/g, "\n") : props.source));
const settledSource = refDebounced(editorSource, 150, { maxWait: 500 });
const members = computed(() => oraclePackageMemberEntries(settledSource.value));

function navigate(offset: number) {
  if (editorSource.value === settledSource.value) emit("navigate", offset);
}
</script>

<template>
  <aside v-if="members.length" :aria-label="t('objects.packageMembers')" class="flex min-h-0 shrink-0 flex-col border-r bg-muted/20" :class="expanded ? 'w-[clamp(8rem,24%,16rem)]' : 'w-8'">
    <div class="flex h-8 shrink-0 items-center gap-1 px-1.5" :class="{ 'border-b': expanded }">
      <h3 v-if="expanded" class="min-w-0 flex-1 truncate pl-1 text-xs font-medium">{{ t("objects.packageMembers") }}</h3>
      <Button
        variant="ghost"
        size="icon"
        class="size-5 shrink-0"
        :title="t(expanded ? 'objects.hidePackageMembers' : 'objects.showPackageMembers')"
        :aria-label="t(expanded ? 'objects.hidePackageMembers' : 'objects.showPackageMembers')"
        :aria-expanded="expanded"
        :aria-controls="listId"
        @click="expanded = !expanded"
      >
        <PanelLeftClose v-if="expanded" class="size-3.5" />
        <PanelLeftOpen v-else class="size-3.5" />
      </Button>
    </div>
    <ul v-show="expanded" :id="listId" class="min-h-0 overflow-auto p-1">
      <li v-for="member in members" :key="member.offset">
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          :title="t(member.isFunction ? 'objects.packageFunctionAtLine' : 'objects.packageProcedureAtLine', { name: member.name, line: member.line })"
          @click="navigate(member.offset)"
        >
          <span aria-hidden="true" class="w-3 shrink-0 text-center text-muted-foreground">{{ member.isFunction ? "ƒ" : "P" }}</span>
          <span class="min-w-0 flex-1 truncate font-mono">{{ member.name }}</span>
          <span class="shrink-0 text-muted-foreground tabular-nums">{{ member.line }}</span>
        </button>
      </li>
    </ul>
  </aside>
</template>
