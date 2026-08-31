import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DriverStoreDialog.vue", import.meta.url), "utf8");
const templateStart = source.indexOf("<template>");
const template = source.slice(templateStart, source.indexOf("\n<style", templateStart)).trim();

describe("DriverStoreDialog visibility", () => {
  it("keeps the page and its auxiliary dialog under one root so component v-show works", () => {
    expect(template).toMatch(/^<template>\s*<div class="driver-store-view[^"]*">[\s\S]*<AgentOfflineExportDialog[^>]*\/>\s*<\/div>\s*<\/template>$/);
  });
});
