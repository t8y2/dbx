<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{
  pageChange: [page: number];
  pageSizeChange: [pageSize: number];
}>();

const { t } = useI18n();
const pageSizeOptions = [50, 100, 200, 500];
const pageCount = computed(() => Math.max(1, Math.ceil(props.totalCount / props.pageSize)));
const rangeStart = computed(() => (props.totalCount ? (props.page - 1) * props.pageSize + 1 : 0));
const rangeEnd = computed(() => Math.min(props.page * props.pageSize, props.totalCount));

function changePageSize(event: Event) {
  const pageSize = Number((event.target as HTMLSelectElement).value);
  if (Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize !== props.pageSize) {
    emit("pageSizeChange", pageSize);
  }
}
</script>

<template>
  <div class="mq-list-pagination" data-testid="mq-list-pagination">
    <span class="mq-list-range">{{ rangeStart }}–{{ rangeEnd }} / {{ totalCount }}</span>
    <label class="mq-list-page-size">
      <span>{{ t("grid.rowsPerPage") }}</span>
      <select :value="pageSize" :disabled="loading" @change="changePageSize">
        <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
      </select>
    </label>
    <button type="button" class="mq-list-page-button" data-testid="mq-list-previous" :aria-label="t('grid.page', { page: Math.max(1, page - 1) })" :disabled="loading || page <= 1" @click="emit('pageChange', page - 1)">‹</button>
    <span class="mq-list-page-number">{{ t("grid.page", { page }) }} / {{ pageCount }}</span>
    <button type="button" class="mq-list-page-button" data-testid="mq-list-next" :aria-label="t('grid.page', { page: page + 1 })" :disabled="loading || !hasMore" @click="emit('pageChange', page + 1)">›</button>
  </div>
</template>

<style scoped>
.mq-list-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: 30px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.mq-list-range,
.mq-list-page-number {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mq-list-page-size {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mq-list-page-size select,
.mq-list-page-button {
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
}

.mq-list-page-size select {
  padding: 0 6px;
}

.mq-list-page-button {
  min-width: 30px;
  padding: 0 8px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.mq-list-page-button:disabled,
.mq-list-page-size select:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
