import { describe, expect, it } from "vitest";
import { elasticsearchJsonResponseForResult } from "@/lib/elasticsearch/elasticsearchJsonResponse";
import type { QueryResult } from "@/types/database";

const catJsonResult: QueryResult = {
  columns: ["status", "response"],
  rows: [[200, '[{"index":"data_pack_and_box_index_v1","docs.count":"42"}]']],
  affected_rows: 0,
  execution_time_ms: 1,
};

describe("Elasticsearch JSON response detection", () => {
  it("routes an unformatted CAT response to the JSON renderer", () => {
    expect(elasticsearchJsonResponseForResult("elasticsearch", "GET /_cat/indices/data_pack_and_box_index_v1", catJsonResult)).toEqual({
      status: 200,
      body: '[{"index":"data_pack_and_box_index_v1","docs.count":"42"}]',
    });
  });
});
