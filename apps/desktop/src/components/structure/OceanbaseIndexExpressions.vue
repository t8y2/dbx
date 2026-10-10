<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ChevronUp, ChevronDown, Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const { t } = useI18n();
function update(position: number, value: string) {
  emit(
    "update:modelValue",
    props.modelValue.map((term, i) => (i === position ? value : term)),
  );
}
function move(position: number, offset: number) {
  const terms = [...props.modelValue];
  const target = position + offset;
  if (target < 0 || target >= terms.length) return;
  [terms[position], terms[target]] = [terms[target]!, terms[position]!];
  emit("update:modelValue", terms);
}
</script>

<template>
  <div class="space-y-1" data-oceanbase-index-expressions>
    <p class="text-xs text-muted-foreground">{{ t("structureEditor.obIndexExpressionHint") }}</p>
    <div v-for="(term, position) in modelValue" :key="position" class="flex items-start gap-1">
      <textarea :value="term" :aria-label="`${t('structureEditor.obIndexExpression')} ${position + 1}`" class="min-h-10 min-w-0 flex-1 rounded border bg-background p-1 font-mono text-xs" rows="2" @input="update(position, ($event.target as HTMLTextAreaElement).value)" />
      <Button variant="ghost" size="icon" :disabled="position === 0" :aria-label="t('structureEditor.obIndexMoveUp')" @click="move(position, -1)"><ChevronUp class="size-3" /></Button>
      <Button variant="ghost" size="icon" :disabled="position === modelValue.length - 1" :aria-label="t('structureEditor.obIndexMoveDown')" @click="move(position, 1)"><ChevronDown class="size-3" /></Button>
      <Button
        variant="ghost"
        size="icon"
        :aria-label="t('structureEditor.obIndexRemoveExpression')"
        @click="
          emit(
            'update:modelValue',
            modelValue.filter((_, i) => i !== position),
          )
        "
        ><X class="size-3"
      /></Button>
    </div>
    <Button variant="outline" size="sm" @click="emit('update:modelValue', [...modelValue, ''])"><Plus class="size-3" />{{ t("structureEditor.obIndexAddExpression") }}</Button>
  </div>
</template>
