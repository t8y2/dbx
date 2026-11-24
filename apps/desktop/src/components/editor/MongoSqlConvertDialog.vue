<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Copy, ExternalLink, Replace } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatMongoShellText } from "@/lib/mongo/mongoFormatter";
import { MongoSqlError, translateMongoSqlScript } from "@/lib/mongo/mongoSql";
import { useToast } from "@/composables/useToast";

/**
 * SQL → MongoDB shell preview (NoSQLBooster's "Convert SQL to MongoDB"):
 * shows the shell the SQL mode would run, without running it, and lets the
 * user copy it, open it in a new Shell tab, or replace the editor text.
 */
const props = defineProps<{
  open: boolean;
  sql: string;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  openInNewTab: [shell: string];
  replace: [shell: string];
}>();

const { t } = useI18n();
const { toast } = useToast();

const conversion = computed<{ shell: string; error?: undefined } | { shell?: undefined; error: string }>(() => {
  if (!props.open) return { shell: "" };
  try {
    const raw = translateMongoSqlScript(props.sql);
    let shell = raw;
    try {
      shell = collapseSpacesAfterColons(formatMongoShellText(raw));
    } catch {
      shell = raw;
    }
    return { shell };
  } catch (error) {
    return { error: error instanceof MongoSqlError || error instanceof Error ? error.message : String(error) };
  }
});

/** The formatter keeps the translator's own space after `key:`, leaving two; collapse them outside strings. */
function collapseSpacesAfterColons(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    out += char;
    if (quote) {
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index++;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ":") {
      while (text[index + 1] === " " && text[index + 2] === " ") index++;
    }
  }
  return out;
}

async function copyShell() {
  if (!conversion.value.shell) return;
  await copyToClipboard(conversion.value.shell);
  toast(t("toolbar.mongoShellCopied"));
}

function openInNewTab() {
  if (!conversion.value.shell) return;
  emit("openInNewTab", conversion.value.shell);
  emit("update:open", false);
}

function replaceEditor() {
  if (!conversion.value.shell) return;
  emit("replace", conversion.value.shell);
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[min(85vh,calc(var(--dbx-viewport-height)-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]" data-mongo-sql-convert>
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <DialogTitle>{{ t("toolbar.convertSqlToMongo") }}</DialogTitle>
        <DialogDescription>{{ t("toolbar.convertSqlToMongoHint") }}</DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4 text-xs">
        <div>
          <div class="mb-1 font-medium text-muted-foreground">SQL</div>
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono">{{ sql.trim() }}</pre>
        </div>
        <div>
          <div class="mb-1 font-medium text-muted-foreground">MongoDB shell</div>
          <pre v-if="conversion.shell" class="max-h-[45vh] overflow-auto whitespace-pre rounded-md border bg-muted/30 p-3 font-mono text-foreground" data-mongo-sql-convert-output>{{ conversion.shell }}</pre>
          <div v-else-if="conversion.error" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive" data-mongo-sql-convert-error>
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span class="whitespace-pre-wrap">{{ conversion.error }}</span>
          </div>
        </div>
      </div>

      <DialogFooter class="mx-0 mb-0 shrink-0 gap-2 border-t px-5 pb-4 pt-3">
        <Button variant="outline" size="sm" :disabled="!conversion.shell" data-action="copy" @click="copyShell"><Copy class="mr-1.5 h-3.5 w-3.5" />{{ t("toolbar.copyMongoShell") }}</Button>
        <Button variant="outline" size="sm" :disabled="!conversion.shell" data-action="new-tab" @click="openInNewTab"><ExternalLink class="mr-1.5 h-3.5 w-3.5" />{{ t("toolbar.openShellInNewTab") }}</Button>
        <Button size="sm" :disabled="!conversion.shell" data-action="replace" @click="replaceEditor"><Replace class="mr-1.5 h-3.5 w-3.5" />{{ t("toolbar.replaceWithShell") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
