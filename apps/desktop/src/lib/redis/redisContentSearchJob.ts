import type { TextContentMatch, TextContentSearchOptions } from "../common/textContentSearch";
import type { JsonTreeSearchMatch, JsonTreeSearchPart } from "../common/jsonTreeSearch";

export interface RedisContentSearchRequest {
  text: string;
  query: string;
  options: TextContentSearchOptions;
  treeParts?: JsonTreeSearchPart[];
  replacement?: string;
  range?: TextContentMatch;
}
export interface RedisContentSearchResult {
  matches: (TextContentMatch | JsonTreeSearchMatch)[];
  changes?: { from: number; to: number; insert: string }[];
  error?: boolean;
}

/** Each job owns a worker, allowing cancellation even during regex backtracking. */
export function startRedisContentSearch(request: RedisContentSearchRequest) {
  let cancel = () => {};
  const result = new Promise<RedisContentSearchResult | null>((resolve) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: RedisContentSearchResult | null) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(value);
    };
    cancel = () => finish(null);
    try {
      worker = new Worker(new URL("./redisContentSearch.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<RedisContentSearchResult>) => finish(event.data);
      worker.onerror = () => finish({ matches: [], error: true });
      timer = setTimeout(() => finish({ matches: [], error: true }), 2000);
      worker.postMessage(request);
    } catch {
      finish({ matches: [], error: true });
    }
  });
  return { result, cancel: () => cancel() };
}
