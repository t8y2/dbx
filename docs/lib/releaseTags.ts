const APP_RELEASE_TAG_PATTERN = /^v[0-9]+[.][0-9]+[.][0-9]+(?:[.-][0-9A-Za-z.-]+)?$/;

export function isAppReleaseTag(tag: string) {
  return APP_RELEASE_TAG_PATTERN.test(tag);
}
