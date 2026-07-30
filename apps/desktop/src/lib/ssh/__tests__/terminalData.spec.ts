import { describe, expect, it } from "vitest";
import { decodeSshTerminalData } from "@/lib/ssh/terminalData";

describe("SSH terminal data transport", () => {
  it("preserves control bytes and invalid UTF-8 output", () => {
    const bytes = Uint8Array.from([0x1b, 0x5b, 0x32, 0x4a, 0xff, 0x00, 0x0a]);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

    expect(decodeSshTerminalData(btoa(binary))).toEqual(bytes);
  });
});
