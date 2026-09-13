import { describe, expect, it } from "vitest";
import { formatError, sanitizeBackendErrorMessage } from "@/lib/backend/errorUtils";

// Reported in #8860: an etcd revision that has already been compacted surfaces
// its internal Agent contract payload in the history dialog.
const COMPACTED_HISTORY_ERROR =
  'ETCD_COMPACTED: requested history was compacted at revision 6538169\nDBX_AGENT_ERROR_DATA:{"contractVersion":1,"category":"protocol","retryable":false,"sessionDisposition":"keep","stage":"execute","operationOutcome":"unknown","agentSessionId":null,"sqlState":null,"vendorCode":null,"exceptionClass":"ETCD_COMPACTED:requestedhistorywascompactedatrevision6538169"}';

describe("KV browser error presentation", () => {
  it("keeps the internal Agent payload out of a compacted-revision history error", () => {
    const expected = "ETCD_COMPACTED: requested history was compacted at revision 6538169";

    expect(sanitizeBackendErrorMessage(COMPACTED_HISTORY_ERROR)).toBe(expected);
    expect(formatError(new Error(COMPACTED_HISTORY_ERROR))).toBe(expected);
  });

  it("leaves an error without the internal marker untouched", () => {
    const message = "etcdserver: permission denied";

    expect(formatError(new Error(message))).toBe(message);
    expect(formatError(message)).toBe(message);
  });
});
