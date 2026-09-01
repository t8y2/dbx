import { describe, expect, it } from "vitest";
import { buildXuguTablespaceChildren, xuguDatafileDisplayName } from "@/lib/sidebar/xuguTablespaces";

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
      xuguDatafilePath: "/data/DATA1.DBF",
    });
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
