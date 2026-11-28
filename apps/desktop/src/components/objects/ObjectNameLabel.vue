<script setup lang="ts">
import { objectBrowserNameTooltip, type ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

// The name column of the object browser. MySQL-family quoted identifiers may keep
// leading/trailing spaces, and ` orders` is a different table from `orders`
// (#14905), so those bytes get a visible marker instead of being trimmed away.
defineProps<{ row: Pick<ObjectBrowserRow, "name" | "displayName" | "nameSpaces"> }>();
</script>

<template>
  <span class="min-w-0" :title="objectBrowserNameTooltip(row)">
    <span v-if="row.nameSpaces?.leading" data-object-name-leading-space class="mr-0.5 inline-flex h-3.5 shrink-0 items-center rounded-sm bg-muted px-0.5 align-middle text-[10px] leading-none text-muted-foreground" aria-hidden="true">␣</span>{{ row.displayName
    }}<span v-if="row.nameSpaces?.trailing" data-object-name-trailing-space class="ml-0.5 inline-flex h-3.5 shrink-0 items-center rounded-sm bg-muted px-0.5 align-middle text-[10px] leading-none text-muted-foreground" aria-hidden="true">␣</span>
  </span>
</template>
