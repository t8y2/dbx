<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { defaultRedisKeyGrouping, validateRedisKeyGrouping, type RedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";
import { uuid } from "@/lib/common/utils";

const props = defineProps<{ open: boolean; config: RedisKeyGrouping; saving: boolean; error: string }>();
const emit = defineEmits<{ "update:open": [boolean]; save: [RedisKeyGrouping] }>();
const { t } = useI18n();
const draft = ref(defaultRedisKeyGrouping());
const invalid = ref(false);
watch(
  () => props.open,
  (open) => {
    if (open) {
      draft.value = validateRedisKeyGrouping(props.config);
      invalid.value = false;
    }
  },
);
function add(example = false) {
  draft.value.rules.push({ id: uuid(), name: example ? "Redisson" : "", enabled: true, includes: example ? ["*:redisson_options"] : ["*"], excludes: [] });
}
function move(index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= draft.value.rules.length) return;
  const rule = draft.value.rules.splice(index, 1)[0]!;
  draft.value.rules.splice(target, 0, rule);
}
function save() {
  try {
    emit("save", validateRedisKeyGrouping(draft.value));
    invalid.value = false;
  } catch {
    invalid.value = true;
  }
}
function patterns(event: Event): string[] {
  return (event.target as HTMLTextAreaElement).value.split("\n").filter((line) => line.length > 0);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader
        ><DialogTitle>{{ t("redisGrouping.settings") }}</DialogTitle></DialogHeader
      >
      <p class="text-xs text-muted-foreground">{{ t("redisGrouping.help") }}</p>
      <div class="max-h-[55vh] space-y-3 overflow-y-auto">
        <fieldset v-for="(rule, index) in draft.rules" :key="rule.id" class="space-y-2 rounded border p-3" :disabled="saving">
          <div class="flex items-center gap-2">
            <input v-model="rule.enabled" type="checkbox" :aria-label="t('redisGrouping.enabled')" />
            <Input v-model="rule.name" :placeholder="t('redisGrouping.name')" :aria-label="t('redisGrouping.name')" />
            <Button variant="outline" size="sm" :disabled="index === 0" :aria-label="t('redisGrouping.up')" @click="move(index, -1)">↑</Button>
            <Button variant="outline" size="sm" :disabled="index === draft.rules.length - 1" :aria-label="t('redisGrouping.down')" @click="move(index, 1)">↓</Button>
            <Button variant="outline" size="sm" @click="draft.rules.splice(index, 1)">{{ t("redisGrouping.remove") }}</Button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-xs">{{ t("redisGrouping.includes") }}<textarea class="w-full rounded border bg-background p-2" :value="rule.includes.join('\n')" @input="rule.includes = patterns($event)" /></label>
            <label class="text-xs">{{ t("redisGrouping.excludes") }}<textarea class="w-full rounded border bg-background p-2" :value="rule.excludes.join('\n')" @input="rule.excludes = patterns($event)" /></label>
          </div>
        </fieldset>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" :disabled="saving || draft.rules.length >= 64" @click="add()">{{ t("redisGrouping.add") }}</Button>
        <Button variant="outline" :disabled="saving || draft.rules.length >= 64" @click="add(true)">{{ t("redisGrouping.example") }}</Button>
      </div>
      <p v-if="invalid || error" role="alert" class="text-sm text-destructive">{{ error || t("redisGrouping.invalid") }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('update:open', false)">{{ t("redisGrouping.cancel") }}</Button>
        <Button :disabled="saving" @click="save">{{ t("redisGrouping.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
