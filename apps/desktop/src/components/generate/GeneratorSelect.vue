<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ChevronRight, Check } from "@lucide/vue";
import { GeneratorHierarchy, getGeneratorCategoryAndLabel, type GeneratorNode } from "@/lib/dataGenerate";

const { t } = useI18n();
const modelValue = defineModel<string | undefined>({ required: false });
const open = ref(false);
const selectedCategory = ref<GeneratorNode | null>(null);

function tr(key: string, fallback: string): string {
  const v = t("dataGenerate.gen." + key);
  return v === "dataGenerate.gen." + key ? fallback : v;
}

const currentLabel = computed(() => {
  if (!modelValue.value) return "";
  const info = getGeneratorCategoryAndLabel(modelValue.value);
  return `${tr(info.category, info.categoryLabel)} / ${tr(modelValue.value, info.label)}`;
});

function selectGenerator(_cat: GeneratorNode, gen: GeneratorNode) {
  modelValue.value = gen.key;
  selectedCategory.value = null;
  open.value = false;
}

function selectCategory(cat: GeneratorNode) {
  selectedCategory.value = cat;
}

function backToCategories() {
  selectedCategory.value = null;
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" class="h-7 w-full justify-start gap-1.5 px-2 text-xs font-normal">
        <span v-if="modelValue" class="truncate text-muted-foreground">{{ currentLabel }}</span>
        <span v-else class="text-muted-foreground/50">{{ t("dataGenerate.selectGenerator") }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-64 p-0" align="start">
      <div v-if="!selectedCategory" class="max-h-[300px] overflow-auto p-1">
        <div v-for="cat in GeneratorHierarchy" :key="cat.key" class="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-xs hover:bg-accent" @click="selectCategory(cat)">
          <span>{{ tr(cat.key, cat.label) }}</span>
          <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </div>
      <div v-else class="max-h-[300px] overflow-auto p-1">
        <div class="border-b px-2.5 py-1.5">
          <button class="text-xs text-muted-foreground hover:text-foreground" @click="backToCategories">← {{ tr(selectedCategory.key, selectedCategory.label) }}</button>
        </div>
        <div v-for="gen in selectedCategory.children" :key="gen.key" class="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-xs hover:bg-accent" @click="selectGenerator(selectedCategory, gen)">
          <span>{{ tr(gen.key, gen.label) }}</span>
          <Check v-if="modelValue === gen.key" class="h-3.5 w-3.5" />
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
