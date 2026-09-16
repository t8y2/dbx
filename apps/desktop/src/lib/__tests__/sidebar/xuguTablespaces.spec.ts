import { describe, expect, it } from "vitest";
import { buildXuguTablespaceChildren, xuguDatafileDetailRows, xuguDatafileDisplayName, xuguTablespaceDetailRows } from "@/lib/sidebar/xuguTablespaces";

describe("Xugu tablespace tree", () => {
  it("uses the physical file basename while retaining the full path", () => {
    expect(xuguDatafileDisplayName("/data/DATA1.DBF", 1)).toBe("DATA1.DBF");
    expect(xuguDatafileDisplayName("", 2)).toBe("file-2");
  });

  it("builds tablespace -> files -> datafile nodes with stable ids", () => {
    const parent = { id: "conn:storage", connectionId: "conn", database: "APP", children: [] };
    const [node] = buildXuguTablespaceChildren(parent, [
      {
        node_id: "1",
        space_id: 7,
        space_name: "DATA1",
        datafile_num: 1,
        space_type: "PERMANENT",
        datafiles: [{ node_id: "1", space_id: 7, path: "/data/DATA1.DBF", file_no: 1, curr_size: 1024 }],
      },
    ]);
    expect(node.id).toBe("conn:storage:tablespace:7");
    expect(node.children?.[0].type).toBe("group-datafiles");
    expect(node.children?.[0].children?.[0]).toMatchObject({
      id: "conn:storage:tablespace:7:files:1:/data/DATA1.DBF",
      type: "datafile",
      label: "DATA1.DBF",
      xuguDatafile: { node_id: "1", space_id: 7, path: "/data/DATA1.DBF", file_no: 1, curr_size: 1024 },
      xuguDatafilePath: "/data/DATA1.DBF",
    });
  });

  it("builds tablespace details and derives chunk usage", () => {
    expect(
      xuguTablespaceDetailRows({
        node_id: "1",
        space_id: 7,
        space_name: "DATA1",
        datafile_num: 2,
        space_type: "DATA_SPACE",
        media_error: "F",
        total_chunk_num: 64,
        free_chunk_num: 16,
        datafiles: [],
      }),
    ).toEqual([
      { key: "name", value: "DATA1" },
      { key: "nodeId", value: "1" },
      { key: "spaceId", value: "7" },
      { key: "spaceType", value: "DATA_SPACE" },
      { key: "datafileCount", value: "2" },
      { key: "totalChunks", value: "64" },
      { key: "freeChunks", value: "16" },
      { key: "usedChunks", value: "48" },
      { key: "usage", value: "75.0%" },
      { key: "mediaError", value: "F" },
    ]);
  });

  it("builds datafile details while preserving nullable size fields", () => {
    expect(
      xuguDatafileDetailRows({
        node_id: "1",
        space_id: 7,
        path: "/data/DATA1.DBF",
        file_no: 1,
        max_size: -1,
        step_size: 64,
        curr_size: 512,
        reserved1: null,
      }),
    ).toEqual([
      { key: "name", value: "DATA1.DBF" },
      { key: "path", value: "/data/DATA1.DBF", multiline: true },
      { key: "nodeId", value: "1" },
      { key: "spaceId", value: "7" },
      { key: "fileNo", value: "1" },
      { key: "currentSize", value: "512" },
      { key: "maxSize", value: "-1" },
      { key: "stepSize", value: "64" },
    ]);
  });

  it("preserves expanded state on refresh", () => {
    const first = buildXuguTablespaceChildren({ id: "conn:storage", connectionId: "conn", database: "APP", children: [] }, [{ node_id: "1", space_id: 7, space_name: "DATA1", datafile_num: 0, space_type: "PERMANENT", datafiles: [] }]);
    first[0].isExpanded = true;
    first[0].children![0].isExpanded = true;
    const second = buildXuguTablespaceChildren({ id: "conn:storage", connectionId: "conn", database: "APP", children: first }, [{ node_id: "1", space_id: 7, space_name: "DATA1", datafile_num: 0, space_type: "PERMANENT", datafiles: [] }]);
    expect(second[0].isExpanded).toBe(true);
    expect(second[0].children?.[0].isExpanded).toBe(true);
  });
});
