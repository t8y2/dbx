import { describe, expect, it } from "vitest";
import { detectAndFormatElasticsearchRequests } from "@/lib/elasticsearch/elasticsearchFormatter";

describe("elasticsearchFormatter", () => {
  describe("detectAndFormatElasticsearchRequests", () => {
    it("pretty-prints a single-line GET request with a JSON body", () => {
      const source = `GET /master_base/_search {"query":{"bool":{"must":[{"term":{"masterId":"47526596395"}}]}}}`;
      const result = detectAndFormatElasticsearchRequests(source, "elasticsearch", 2);
      expect(result).toEqual({
        kind: "elasticsearch",
        formatted: `GET /master_base/_search
{
  "query": {
    "bool": {
      "must": [
        {
          "term": {
            "masterId": "47526596395"
          }
        }
      ]
    }
  }
}`,
      });
    });

    it("leaves a request with no body as just the method/path line", () => {
      const result = detectAndFormatElasticsearchRequests("GET /_cat/indices", "elasticsearch", 2);
      expect(result).toEqual({ kind: "elasticsearch", formatted: "GET /_cat/indices" });
    });

    it("formats multiple requests separated by a blank line, keeping the separator", () => {
      const source = `GET /a/_search {"query":{"match_all":{}}}\n\nPOST /b/_refresh`;
      const result = detectAndFormatElasticsearchRequests(source, "easysearch", 2);
      expect(result).toEqual({
        kind: "elasticsearch",
        formatted: `GET /a/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n\nPOST /b/_refresh`,
      });
    });

    it("reports unsupported (and keeps caller from touching the text) for an invalid JSON body", () => {
      const result = detectAndFormatElasticsearchRequests(`GET /a/_search {"query":`, "elasticsearch", 2);
      expect(result).toEqual({ kind: "unsupported" });
    });

    it("reports not-elasticsearch for bare JSON with no method/path line", () => {
      const result = detectAndFormatElasticsearchRequests(`{"query":{"match_all":{}}}`, "elasticsearch", 2);
      expect(result).toEqual({ kind: "not-elasticsearch" });
    });

    it("reports not-elasticsearch for non-elasticsearch database types", () => {
      const source = `GET /master_base/_search {"query":{"match_all":{}}}`;
      expect(detectAndFormatElasticsearchRequests(source, "mysql", 2)).toEqual({ kind: "not-elasticsearch" });
      expect(detectAndFormatElasticsearchRequests(source, undefined, 2)).toEqual({ kind: "not-elasticsearch" });
    });

    it("formats meilisearch requests too", () => {
      const result = detectAndFormatElasticsearchRequests(`POST /indexes/movies/search {"q":"batman"}`, "meilisearch", 2);
      expect(result).toEqual({
        kind: "elasticsearch",
        formatted: `POST /indexes/movies/search\n{\n  "q": "batman"\n}`,
      });
    });
  });
});
