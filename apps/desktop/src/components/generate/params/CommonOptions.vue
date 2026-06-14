<script setup lang="ts">
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "vue-i18n";
import type { GeneratorParams } from "@/lib/dataGenerate";

const props = defineProps<{
  params: GeneratorParams;
  disableDefault?: boolean;
  disableNull?: boolean;
  disableUnique?: boolean;
  disableLinks?: boolean;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="rounded-md border bg-muted/10 p-3 space-y-2">
    <div v-if="!disableDefault" class="flex items-center gap-2 text-xs">
      <input id="opt-default" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.includeDefault" @change="params.includeDefault = !params.includeDefault" />
      <Label for="opt-default" class="text-muted-foreground">{{ t("dataGenerate.includeDefault") }}</Label>
      <div v-if="params.includeDefault" class="flex items-center gap-1 ml-auto">
        <Input v-model.number="params.defaultPercent" type="number" min="0" max="100" class="h-6 w-16 text-xs" />
        <span class="text-muted-foreground">%</span>
      </div>
    </div>

    <div v-if="!disableNull" class="flex items-center gap-2 text-xs">
      <input id="opt-null" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.includeNull" @change="params.includeNull = !params.includeNull" />
      <Label for="opt-null" class="text-muted-foreground">{{ t("dataGenerate.includeNull") }}</Label>
      <div v-if="params.includeNull" class="flex items-center gap-1 ml-auto">
        <Input v-model.number="params.nullPercent" type="number" min="0" max="100" class="h-6 w-16 text-xs" />
        <span class="text-muted-foreground">%</span>
      </div>
    </div>

    <div v-if="!disableUnique" class="flex items-center gap-2 text-xs">
      <input id="opt-unique" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.unique" @change="params.unique = !params.unique" />
      <Label for="opt-unique" class="text-muted-foreground">{{ t("dataGenerate.unique") }}</Label>
    </div>

    <div v-if="!disableLinks" class="flex items-center gap-2 text-xs">
      <input id="opt-links" type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!params.disableLinks" @change="params.disableLinks = !params.disableLinks" />
      <Label for="opt-links" class="text-muted-foreground">{{ t("dataGenerate.disableLinks") }}</Label>
    </div>
  </div>
</template>
