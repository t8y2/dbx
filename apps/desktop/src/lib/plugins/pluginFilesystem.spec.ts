import { describe, expect, it } from "vitest";
import { pluginFilesystemParentUri, pluginFilesystemRootUri, sortPluginFilesystemEntries } from "./pluginFilesystem";

describe("plugin filesystem navigation", () => {
  it("derives a default root from the first declared scheme", () => {
    expect(pluginFilesystemRootUri({ schemes: ["sftp"] })).toBe("sftp:/");
    expect(pluginFilesystemRootUri({ schemes: ["s3"], root_uri: "s3://bucket/" })).toBe("s3://bucket/");
  });

  it("keeps parent navigation inside the declared root", () => {
    expect(pluginFilesystemParentUri("sftp:/home/user/files/", "sftp:/")).toBe("sftp:/home/user/");
    expect(pluginFilesystemParentUri("s3://bucket/reports/2026/", "s3://bucket/")).toBe("s3://bucket/reports/");
    expect(pluginFilesystemParentUri("s3://bucket/reports/", "s3://bucket/reports/")).toBeUndefined();
  });

  it("sorts directories before naturally ordered files", () => {
    const sorted = sortPluginFilesystemEntries([
      { name: "file10.txt", uri: "sample:/file10.txt", kind: "file" },
      { name: "folder", uri: "sample:/folder/", kind: "directory" },
      { name: "file2.txt", uri: "sample:/file2.txt", kind: "file" },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["folder", "file2.txt", "file10.txt"]);
  });
});
