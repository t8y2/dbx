export function createUncachedUrl(url: string, cacheBuster?: string | number) {
  if (cacheBuster === undefined) return url;

  const nextUrl = new URL(url);
  nextUrl.searchParams.set("_ts", String(cacheBuster));
  return nextUrl.toString();
}

export function browserCacheBuster() {
  return typeof window === "undefined" ? undefined : Date.now();
}

export function releaseMetadataRequestInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  };
}
