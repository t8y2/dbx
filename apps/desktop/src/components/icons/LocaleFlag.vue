<script setup lang="ts">
import type { LocaleOption } from "@/lib/app/localeOptions";
import { webPath } from "@/lib/common/webPath";

defineProps<{ option: LocaleOption }>();
</script>

<template>
  <span aria-hidden="true" class="inline-flex h-5 w-6 shrink-0 items-center justify-center text-sm font-medium leading-none">
    <img v-if="option.flagIcon" :src="webPath(`/icons/flags/${option.flagIcon}.svg`)" alt="" width="20" height="15" class="h-[15px] w-5 rounded-[1px] object-contain" />
    <span v-else>{{ option.flag }}</span>
  </span>
</template>
