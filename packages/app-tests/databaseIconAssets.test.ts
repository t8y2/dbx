import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

test("Kafka database icon includes a light contrast stroke for dark themes", () => {
  const svg = readFileSync(path.resolve("apps/desktop/public/icons/database/kafka.svg"), "utf8");

  assert.match(svg, /stroke="#(?:F8FAFC|E5E7EB|FFFFFF)"/i);
  assert.match(svg, /fill="#231F20"/i);
});

test("RocketMQ database icon asset exists", () => {
  const svg = readFileSync(path.resolve("apps/desktop/public/icons/database/rocketmq.svg"), "utf8");
  assert.match(svg, /<svg/i);
});

test("Apache Phoenix database icon keeps its official source attribution", () => {
  const svg = readFileSync(path.resolve("apps/desktop/public/icons/database/phoenix.svg"), "utf8");
  assert.match(svg, /https:\/\/phoenix\.apache\.org\/images\/logo\.svg/);
  assert.match(svg, /Apache Phoenix logo/);
  assert.match(svg, /#f7931d/i);
  assert.match(svg, /#ed1c24/i);
});

test("Inceptor connection icon matches the Waterdrop provider asset", () => {
  const png = readFileSync(path.resolve("apps/desktop/public/icons/database/transwarp-inceptor.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
});
