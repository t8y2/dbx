import assert from "node:assert/strict";
import { test } from "vitest";
import { createUncachedUrl, releaseMetadataRequestInit } from "./releaseMetadataRequest";

test("createUncachedUrl appends cache buster without removing existing query params", () => {
  assert.equal(createUncachedUrl("https://dl.dbxio.com/releases/latest/latest.json?lang=cn", 123), "https://dl.dbxio.com/releases/latest/latest.json?lang=cn&_ts=123");
});

test("createUncachedUrl leaves server-side build URLs stable without a cache buster", () => {
  assert.equal(createUncachedUrl("https://dl.dbxio.com/releases/latest/latest.json"), "https://dl.dbxio.com/releases/latest/latest.json");
});

test("releaseMetadataRequestInit disables fetch cache and preserves custom headers", () => {
  assert.deepEqual(releaseMetadataRequestInit({ headers: { Authorization: "token example" } }), {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: "token example",
    },
  });
});
