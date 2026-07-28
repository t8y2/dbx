import assert from "node:assert/strict";
import { test } from "vitest";
import * as gridFsBrowserModule from "../../apps/desktop/src/lib/document/gridFsBrowser.ts";
import {
  buildGridFsFilesStructuredFilter,
  currentGridFsBucketFilter,
  currentGridFsBucketSort,
  currentGridFsBucketSortDirection,
  currentGridFsFileSortDirection,
  gridFsFileFilterFieldOptions,
  gridFsBucketSortInputForColumn,
  gridFsFilesQueryPreview,
  parseGridFsBucketSort,
} from "../../apps/desktop/src/lib/document/gridFsBrowser.ts";

test("builds a Mongo-style GridFS files query preview", () => {
  assert.equal(
    gridFsFilesQueryPreview({
      bucket: "fs",
      filterJson: '{"metadata.owner":"alice"}',
      sortJson: '{"uploadDate":-1}',
    }),
    'db.getCollection("fs.files").find({"metadata.owner":"alice"}).sort({"uploadDate":-1})',
  );
});

test("omits the sort stage when the GridFS file preview has no explicit sort", () => {
  assert.equal(
    gridFsFilesQueryPreview({
      bucket: "fs",
      filterJson: '{"filename":"report.zip"}',
    }),
    'db.getCollection("fs.files").find({"filename":"report.zip"})',
  );
});

test("normalizes GridFS bucket filters by trimming blank input", () => {
  assert.equal(currentGridFsBucketFilter("   nightly  "), "nightly");
  assert.equal(currentGridFsBucketFilter("   "), undefined);
});

test("normalizes GridFS manager sort directions for supported fields", () => {
  assert.deepEqual(parseGridFsBucketSort('{"totalBytes":-1}'), { field: "totalBytes", direction: "desc" });
  assert.deepEqual(parseGridFsBucketSort("{ fileCount: 1 }"), { field: "fileCount", direction: "asc" });
});

test("serializes GridFS manager sort input for supported columns", () => {
  assert.equal(gridFsBucketSortInputForColumn("name", "asc"), '{"name":1}');
  assert.equal(gridFsBucketSortInputForColumn("totalBytes", "desc"), '{"totalBytes":-1}');
  assert.equal(gridFsBucketSortInputForColumn("fileCount", null), "");
});

test("rejects unsupported GridFS bucket sort fields", () => {
  assert.throws(() => parseGridFsBucketSort('{"createdAt":-1}'), /Unsupported GridFS bucket sort field/);
});

test("returns canonical GridFS bucket sort JSON", () => {
  assert.equal(currentGridFsBucketSort("{ totalBytes: -1 }"), '{"totalBytes":-1}');
  assert.equal(currentGridFsBucketSort("   "), undefined);
});

test("exposes the available GridFS file filter fields for the compact builder", () => {
  assert.deepEqual(gridFsFileFilterFieldOptions, ["_id", "filename", "contentType", "length", "chunkSize", "uploadDate", "md5"]);
});

test("exposes shared GridFS file field display metadata for filters and headers", () => {
  assert.deepEqual((gridFsBrowserModule as any).gridFsFileFieldDisplayOptions, [
    { fieldName: "_id", label: "ID" },
    { fieldName: "filename", labelKey: "gridfsBrowser.name" },
    { fieldName: "contentType", labelKey: "gridfsBrowser.contentType" },
    { fieldName: "length", labelKey: "gridfsBrowser.totalSize" },
    { fieldName: "chunkSize", labelKey: "gridfsBrowser.chunkSize" },
    { fieldName: "uploadDate", labelKey: "gridfsBrowser.uploadDate" },
    { fieldName: "md5", label: "MD5" },
  ]);
});

test("combines GridFS file filter rules into a MongoDB structured filter", () => {
  assert.deepEqual(
    buildGridFsFilesStructuredFilter([
      {
        id: "rule-1",
        fieldName: "filename",
        mode: "equals",
        rawValue: "report.zip",
        conjunction: "AND",
      },
      {
        id: "rule-2",
        fieldName: "contentType",
        mode: "like",
        rawValue: "image",
        conjunction: "AND",
      },
    ]),
    {
      $and: [
        { filename: "report.zip" },
        { contentType: { $regex: "image", $options: "i" } },
      ],
    },
  );
});

test("derives explicit GridFS file sort directions for visible header indicators", () => {
  assert.equal(currentGridFsFileSortDirection('{"filename":1}', "filename"), "asc");
  assert.equal(currentGridFsFileSortDirection('{"filename":-1}', "filename"), "desc");
  assert.equal(currentGridFsFileSortDirection('{"filename":1}', "uploadDate"), "none");
  assert.equal(currentGridFsFileSortDirection('{"filename":1,"uploadDate":-1}', "filename"), "none");
});

test("derives explicit GridFS bucket sort directions for visible header indicators", () => {
  assert.equal(currentGridFsBucketSortDirection('{"name":1}', "name"), "asc");
  assert.equal(currentGridFsBucketSortDirection('{"totalBytes":-1}', "totalBytes"), "desc");
  assert.equal(currentGridFsBucketSortDirection('{"name":1}', "fileCount"), "none");
});
