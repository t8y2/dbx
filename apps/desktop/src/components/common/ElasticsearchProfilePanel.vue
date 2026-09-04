<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Gauge, ChevronsDown, ChevronsUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import ElasticsearchProfileNodeRow from "@/components/common/ElasticsearchProfileNodeRow.vue";
import { countProfileNodes, formatProfileNanos, parseElasticsearchProfile, type ElasticsearchProfileShard } from "@/lib/elasticsearch/elasticsearchProfile";

const props = defineProps<{
  /** The raw Elasticsearch `_search` response body. */
  body: string;
}>();

const { t } = useI18n();
const parsed = computed(() => parseElasticsearchProfile(props.body));
const shards = computed<ElasticsearchProfileShard[]>(() => parsed.value?.shards ?? []);
const activeShardIndex = ref(0);
const globalCollapse = ref<"expanded" | "collapsed" | null>(null);

watch(
  () => props.body,
  () => {
    activeShardIndex.value = 0;
    globalCollapse.value = null;
  },
);

watch(
  () => parsed.value?.shards.length ?? 0,
  () => {
    if (activeShardIndex.value >= shards.value.length) activeShardIndex.value = 0;
  },
);

const activeShard = computed(() => shards.value[activeShardIndex.value]);
const nodeCount = computed(() => (activeShard.value ? countProfileNodes(activeShard.value.tree) : 0));
const showCollapseProtection = computed(() => nodeCount.value > 80 && globalCollapse.value === null);
const searchLabel = computed(() => (activeShard.value?.searchCount && activeShard.value.searchCount > 1 ? ` · ${activeShard.value.searchCount} ${t("profile.searches")}` : ""));
</script>

<template>
  <section data-elasticsearch-profile-root class="relative flex h-full min-h-0 flex-col bg-background">
    <header class="flex min-h-11 shrink-0 items-center gap-2 border-b bg-muted/25 px-3 py-1.5 text-xs">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm" aria-hidden="true">
          <Gauge class="h-3.5 w-3.5" />
        </span>
        <span class="font-medium">{{ t("profile.title") }}</span>
        <div v-if="shards.length > 1" class="ml-1 inline-flex h-7 items-center overflow-hidden rounded-md border bg-muted/45 p-0.5">
          <button
            v-for="(shard, index) in shards"
            :key="shard.id"
            type="button"
            class="h-6 min-w-0 max-w-40 truncate whitespace-nowrap rounded-[4px] px-2 text-xs transition-colors"
            :class="activeShardIndex === index ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="activeShardIndex === index"
            :title="t('profile.shard')"
            @click="activeShardIndex = index"
          >
            {{ shard.id }}
          </button>
        </div>
        <span class="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground" role="status"> {{ activeShard ? formatProfileNanos(activeShard.totalTimeInNanos) : "—" }}{{ searchLabel }} </span>
      </div>
      <LightTooltip :text="t('profile.collapseAll')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('profile.collapseAll')" :aria-label="t('profile.collapseAll')" :disabled="!activeShard" @click="globalCollapse = 'collapsed'">
          <ChevronsUp class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('profile.expandAll')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('profile.expandAll')" :aria-label="t('profile.expandAll')" :disabled="!activeShard" @click="globalCollapse = 'expanded'">
          <ChevronsDown class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
    </header>

    <div class="min-h-0 flex-1 overflow-auto bg-background p-3">
      <div v-if="!parsed" data-profile-empty class="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <div>{{ t("profile.emptyProfile") }}</div>
      </div>
      <div v-else-if="shards.length === 0" data-profile-empty class="flex h-full items-center justify-center text-sm text-muted-foreground">
        {{ t("profile.emptyShards") }}
      </div>
      <template v-else>
        <div v-if="showCollapseProtection" class="mb-2 rounded border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {{ t("profile.collapsedProtection", { nodes: nodeCount }) }}
        </div>
        <ElasticsearchProfileNodeRow :node="activeShard!.tree" :global-collapse="globalCollapse" @manual="globalCollapse = null" />
      </template>
    </div>
  </section>
</template>
