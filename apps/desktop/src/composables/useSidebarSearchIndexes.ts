import { onScopeDispose, ref, shallowRef, watch, type Ref, type WatchSource } from "vue";
import type { SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarTableCommentUpdates, patchSidebarTableCommentScopes, type SidebarTableCommentUpdate } from "@/lib/sidebar/sidebarTableCommentUpdates";

export function useSidebarSearchIndexes(options: {
  query: Ref<string>;
  context: WatchSource[];
  commentUpdate?: WatchSource<SidebarTableCommentUpdate | null>;
  load: (shouldCancel: () => boolean, onProgress: (scopes: SidebarRegexIndexScope[]) => void) => Promise<SidebarRegexIndexScope[]>;
  onError: (error: unknown) => void;
}) {
  const scopes = shallowRef<SidebarRegexIndexScope[]>([]);
  const isLoading = ref(false);
  const commentUpdates = createSidebarTableCommentUpdates();
  let generation = 0;

  if (options.commentUpdate) {
    watch(
      options.commentUpdate,
      (update) => {
        if (!update) return;
        commentUpdates.record(update);
        scopes.value = patchSidebarTableCommentScopes(scopes.value, [update]);
      },
      { flush: "sync" },
    );
  }

  watch([() => !!options.query.value, ...options.context], () => {
    const currentGeneration = ++generation;
    scopes.value = [];
    isLoading.value = !!options.query.value;
    if (!isLoading.value) return;
    const updates = commentUpdates.begin();
    const shouldCancel = () => currentGeneration !== generation || !options.query.value;
    const publish = (loaded: SidebarRegexIndexScope[]) => {
      if (!shouldCancel()) scopes.value = updates.patchScopes(loaded);
    };
    void options
      .load(shouldCancel, publish)
      .then((loaded) => {
        if (!shouldCancel()) scopes.value = updates.patchScopes(loaded);
      })
      .catch((error) => {
        if (!shouldCancel()) options.onError(error);
      })
      .finally(() => {
        updates.finish();
        if (currentGeneration === generation) isLoading.value = false;
      });
  });

  onScopeDispose(() => {
    generation += 1;
  });

  return { scopes, isLoading };
}
