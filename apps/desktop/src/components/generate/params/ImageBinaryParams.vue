<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{ params: GeneratorParams }>();

const { t } = useI18n();

const isGenerate = computed(() => props.params.imageMode !== "folder");
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">{{ t("dataGenerate.imageMode") }}</div>
      <div class="flex items-center gap-2 text-xs">
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="isGenerate ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.imageMode = 'generate'">{{ t("dataGenerate.generate") }}</button>
        <button type="button" class="px-2 py-1 rounded border text-xs" :class="!isGenerate ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.imageMode = 'folder'">{{ t("dataGenerate.fromFolder") }}</button>
      </div>
    </div>

    <template v-if="isGenerate">
      <div class="rounded-md border bg-muted/10 p-3 space-y-2">
        <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
          <Label class="text-muted-foreground">{{ t("dataGenerate.imageWidth") }}</Label>
          <Input v-model.number="params.imageWidth" type="number" placeholder="200" class="h-7 w-24 text-xs" />
        </div>
        <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
          <Label class="text-muted-foreground">{{ t("dataGenerate.imageHeight") }}</Label>
          <Input v-model.number="params.imageHeight" type="number" placeholder="200" class="h-7 w-24 text-xs" />
        </div>
        <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
          <Label class="text-muted-foreground">{{ t("dataGenerate.imageFormat") }}</Label>
          <div class="flex items-center gap-2">
            <button type="button" class="px-2 py-1 rounded border text-xs" :class="(params.imageFormat || 'JPEG') === 'JPEG' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.imageFormat = 'JPEG'">JPEG</button>
            <button type="button" class="px-2 py-1 rounded border text-xs" :class="params.imageFormat === 'PNG' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.imageFormat = 'PNG'">PNG</button>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="rounded-md border bg-muted/10 p-3 space-y-2">
        <div class="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
          <Label class="text-muted-foreground">{{ t("dataGenerate.folderPath") }}</Label>
          <Input v-model="params.folderPath" type="text" placeholder="/path/to/images" class="h-7 text-xs" />
        </div>
        <div class="text-xs text-muted-foreground mt-2 mb-1">{{ t("dataGenerate.filterByExtension") }}</div>
        <textarea v-model="params.fileExtensions" rows="3" class="w-full rounded border bg-background px-2 py-1 text-xs font-mono resize-y" placeholder="每行一个扩展名&#10;png&#10;jpg&#10;txt" />
      </div>
    </template>
  </div>
</template>
