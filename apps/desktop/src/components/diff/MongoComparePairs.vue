<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { matchMongoCollections, type MongoCollectionPair } from "@/lib/mongo/mongoCompareBatch";

const props = defineProps<{ sourceCollections: string[]; targetCollections: string[]; disabled: boolean; defaultMatchFields: string }>();
const pairs = defineModel<MongoCollectionPair[]>({ required: true });
const { t } = useI18n();
function update(index: number, patch: Partial<MongoCollectionPair>) {
  pairs.value = pairs.value.map((pair, i) => (i === index ? { ...pair, ...patch } : pair));
}
function autoMatch() {
  pairs.value = matchMongoCollections(props.sourceCollections, props.targetCollections, pairs.value).slice(0, 100);
}
</script>

<template>
  <section class="space-y-2" :aria-label="t('mongoCompare.pairs')">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="text-xs font-semibold">{{ t("mongoCompare.pairs") }} ({{ pairs.length }} / 100)</h3>
      <Button size="sm" variant="outline" :disabled="disabled || pairs.length >= 100 || !sourceCollections.length || !targetCollections.length" @click="autoMatch">{{ t("mongoCompare.autoMatch") }}</Button>
      <Button size="sm" variant="ghost" :disabled="disabled || pairs.length >= 100" @click="pairs = [...pairs, { source: '', target: '', enabled: true, matchFields: '' }]">{{ t("mongoCompare.addPair") }}</Button>
    </div>
    <div v-if="pairs.length" class="max-h-56 overflow-auto rounded-md border border-border">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-muted">
          <tr>
            <th class="p-2">{{ t("mongoCompare.select") }}</th>
            <th class="p-2 text-left">{{ t("mongoCompare.source") }}</th>
            <th class="p-2 text-left">{{ t("mongoCompare.target") }}</th>
            <th class="p-2 text-left">{{ t("mongoCompare.pairKeys") }}</th>
            <th class="p-2">
              <span class="sr-only">{{ t("mongoCompare.removePair") }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(pair, index) in pairs" :key="index" class="border-t border-border">
            <td class="p-2">
              <input type="checkbox" :checked="pair.enabled" :disabled="disabled" :aria-label="`${t('mongoCompare.select')} ${index + 1}`" @change="update(index, { enabled: !pair.enabled })" />
            </td>
            <td v-for="side in ['source', 'target'] as const" :key="side" class="min-w-40 p-2">
              <Select :model-value="pair[side]" :disabled="disabled" @update:model-value="(value) => update(index, { [side]: String(value) })">
                <SelectTrigger class="h-8 text-xs" :aria-label="`${t(`mongoCompare.${side}`)} ${index + 1}`"><SelectValue :placeholder="t('mongoCompare.collection')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-if="pair[side] && !(side === 'source' ? sourceCollections : targetCollections).includes(pair[side])" :value="pair[side]">{{ pair[side] }} — {{ t("mongoCompare.unavailable") }}</SelectItem>
                  <SelectItem v-for="name in side === 'source' ? sourceCollections : targetCollections" :key="name" :value="name">{{ name }}</SelectItem>
                </SelectContent>
              </Select>
            </td>
            <td class="min-w-40 p-2">
              <Input :model-value="pair.matchFields" :disabled="disabled" :placeholder="defaultMatchFields" :aria-label="`${t('mongoCompare.pairKeys')} ${index + 1}`" class="h-8 font-mono text-xs" @update:model-value="(value) => update(index, { matchFields: String(value) })" />
            </td>
            <td class="p-2">
              <Button variant="ghost" size="sm" :disabled="disabled" :aria-label="`${t('mongoCompare.removePair')} ${index + 1}`" @click="pairs = pairs.filter((_, i) => i !== index)">×</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-xs text-muted-foreground">{{ t("mongoCompare.batchHint") }}</p>
  </section>
</template>
