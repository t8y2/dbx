<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ExternalLink, Loader2, RefreshCw, Tag } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { currentLocale } from "@/i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { changelogLangFromLocale, changelogReleaseUrl, changelogWebsiteUrl, createLatestRequestGuard, fetchChangelog, type ChangelogLang, type ChangelogRelease } from "@/lib/app/changelog";

const PAGE_SIZE = 5;

const { t, locale } = useI18n();

const loading = ref(false);
const error = ref("");
const releases = ref<ChangelogRelease[]>([]);
const visibleCount = ref(PAGE_SIZE);
const expandedTags = ref<Set<string>>(new Set());
const loadedLang = ref<ChangelogLang | null>(null);
const loadRequest = createLatestRequestGuard();

const changelogLang = computed(() => changelogLangFromLocale(locale.value || currentLocale()));
const visibleReleases = computed(() => releases.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < releases.value.length);
const latestTag = computed(() => releases.value[0]?.tag ?? "");

function isLatestRelease(tag: string) {
  return !!latestTag.value && tag === latestTag.value;
}

function sectionLabel(type: string, fallback: string) {
  const keyByType: Record<string, string> = {
    added: "settings.changelogSectionAdded",
    improved: "settings.changelogSectionImproved",
    fixed: "settings.changelogSectionFixed",
    changed: "settings.changelogSectionChanged",
    removed: "settings.changelogSectionRemoved",
  };
  const key = keyByType[type];
  if (!key) return fallback;
  const translated = t(key);
  return translated === key ? fallback : translated;
}

function formatReleaseDate(dateStr: string) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  try {
    return new Intl.DateTimeFormat(locale.value || currentLocale(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return dateStr;
  }
}

function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function isExpanded(tag: string) {
  return expandedTags.value.has(tag);
}

function toggleRelease(tag: string) {
  const next = new Set(expandedTags.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  expandedTags.value = next;
}

function loadMore() {
  visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, releases.value.length);
}

async function load(force = false) {
  const lang = changelogLang.value;
  const requestId = loadRequest.begin();
  loading.value = true;
  error.value = "";
  try {
    const data = await fetchChangelog(lang, { force });
    if (!loadRequest.isCurrent(requestId)) return;
    releases.value = data.releases;
    loadedLang.value = lang;
    visibleCount.value = PAGE_SIZE;
    expandedTags.value = new Set();
  } catch (e: any) {
    if (!loadRequest.isCurrent(requestId)) return;
    releases.value = [];
    loadedLang.value = null;
    error.value = e?.message || String(e);
  } finally {
    if (loadRequest.isCurrent(requestId)) loading.value = false;
  }
}

onMounted(() => {
  void load();
});

watch(changelogLang, (lang) => {
  if (lang !== loadedLang.value) {
    void load();
  }
});
</script>

<template>
  <div class="rounded-lg border p-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 space-y-1">
        <Label>{{ t("settings.changelogTitle") }}</Label>
        <p class="text-sm text-muted-foreground">{{ t("settings.changelogDescription") }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" :disabled="loading" @click="openExternalUrl(changelogWebsiteUrl(changelogLang))">
          <ExternalLink class="mr-1 h-3.5 w-3.5" />
          {{ t("settings.changelogOpenWebsite") }}
        </Button>
        <Button type="button" variant="outline" size="sm" :disabled="loading" :title="t('settings.changelogRetry')" :aria-label="t('settings.changelogRetry')" @click="load(true)">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>

    <div v-if="loading && !releases.length" class="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("settings.changelogLoading") }}
    </div>

    <div v-else-if="error && !releases.length" class="mt-4 space-y-3">
      <p class="text-sm text-destructive">{{ t("settings.changelogLoadFailed") }}</p>
      <div class="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" @click="load(true)">{{ t("settings.changelogRetry") }}</Button>
        <Button type="button" variant="outline" size="sm" @click="openExternalUrl(changelogWebsiteUrl(changelogLang))">
          <ExternalLink class="mr-1 h-3.5 w-3.5" />
          {{ t("settings.changelogOpenWebsite") }}
        </Button>
      </div>
    </div>

    <p v-else-if="!releases.length" class="mt-4 text-sm text-muted-foreground">{{ t("settings.changelogEmpty") }}</p>

    <div v-else class="mt-4 space-y-2">
      <div v-for="release in visibleReleases" :key="release.tag" class="relative overflow-hidden rounded-md border bg-muted/20" :class="isLatestRelease(release.tag) ? 'border-primary/35' : ''">
        <button type="button" class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-expanded="isExpanded(release.tag)" @click="toggleRelease(release.tag)">
          <Badge variant="secondary" class="shrink-0 gap-1 font-mono text-[11px]">
            <Tag class="h-3 w-3" />
            {{ release.tag.replace(/^v/, "") }}
          </Badge>
          <span v-if="isLatestRelease(release.tag)" class="shrink-0 rounded-sm bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-primary-foreground">
            {{ t("settings.changelogNew") }}
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {{ t("settings.changelogPublishedOn", { date: formatReleaseDate(release.date) }) }}
          </span>
          <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="isExpanded(release.tag) ? 'rotate-180' : ''" />
        </button>

        <div v-if="isExpanded(release.tag)" class="border-t border-border/60 px-3 py-3">
          <template v-if="release.sections.length">
            <div v-for="(section, sectionIndex) in release.sections" :key="`${release.tag}-${section.type}-${sectionIndex}`" :class="sectionIndex > 0 ? 'mt-3' : ''">
              <div class="mb-1.5 text-xs font-semibold text-foreground">{{ sectionLabel(section.type, section.title) }}</div>
              <ul class="space-y-1.5">
                <li v-for="(item, itemIndex) in section.items" :key="itemIndex" class="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>
                    <template v-if="item.desc">{{ item.title }} — {{ item.desc }}</template>
                    <template v-else>{{ item.title }}</template>
                  </span>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="text-xs italic text-muted-foreground">{{ t("settings.changelogNoDetails") }}</p>

          <Button type="button" variant="ghost" size="sm" class="mt-3 h-7 px-2 text-xs" @click.stop="openExternalUrl(changelogReleaseUrl(release.tag))">
            <ExternalLink class="mr-1 h-3 w-3" />
            {{ t("settings.changelogOpenGitHub") }}
          </Button>
        </div>
      </div>

      <div v-if="hasMore" class="pt-1">
        <Button type="button" variant="outline" size="sm" class="w-full" @click="loadMore">
          {{ t("settings.changelogLoadMore") }}
        </Button>
      </div>
    </div>
  </div>
</template>
