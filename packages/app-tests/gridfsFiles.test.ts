import assert from "node:assert/strict";
import dayjs from "dayjs";
import { test } from "vitest";

import { buildGridFsDownloadArchive, defaultGridFsArchiveFileName, formatGridFsUploadDate } from "../../apps/desktop/src/lib/document/gridfsFiles.ts";

test("formats GridFS upload timestamps as compact local datetimes", () => {
  const raw = "2026-07-07T01:22:42.123Z";
  assert.equal(formatGridFsUploadDate(raw), dayjs(raw).format("YYYY-MM-DD HH:mm:ss"));
});

test("keeps invalid GridFS upload timestamps readable", () => {
  assert.equal(formatGridFsUploadDate("not-a-date"), "not-a-date");
  assert.equal(formatGridFsUploadDate(""), "-");
  assert.equal(formatGridFsUploadDate(undefined), "-");
});

test("builds a GridFS download zip with safe deduplicated file names", () => {
  const archive = buildGridFsDownloadArchive([
    { id: "alpha", filename: "report.txt", data: new TextEncoder().encode("hello") },
    { id: "beta", filename: "report.txt", data: new TextEncoder().encode("world") },
    { id: "gamma", filename: "bad/name?.json", data: new TextEncoder().encode("{}") },
    { id: "delta", data: new TextEncoder().encode("fallback") },
  ]);
  const text = new TextDecoder().decode(archive);

  assert.equal(archive[0], 0x50);
  assert.equal(archive[1], 0x4b);
  assert.match(text, /report\.txt/);
  assert.match(text, /report-2\.txt/);
  assert.match(text, /bad-name\.json/);
  assert.match(text, /delta\.bin/);
});

test("builds a timestamped GridFS archive file name from the bucket", () => {
  const now = new Date("2026-07-07T01:22:42.000Z");
  assert.equal(
    defaultGridFsArchiveFileName("user uploads", now),
    `user-uploads-gridfs-${dayjs(now).format("YYYYMMDD-HHmmss")}.zip`,
  );
});
