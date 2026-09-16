import type { AnnotationFile, SchemaSnapshot } from "@/docs/types";
import type { ExportLocale } from "./exportTranslate";

/**
 * The contract between the exporter and this bundle.
 *
 * Task 6's Rust side serialises exactly this object as JSON, encodes it UTF-8
 * then base64, and writes it as the text of
 * `<script type="application/dbx-snapshot">`. Nothing else in the emitted
 * document is read by the bundle.
 *
 * `lang` picks the starting locale only. The reader can change it — the
 * person who exported the file is rarely the person who opens it.
 */
export interface ExportPayload {
  snapshot: SchemaSnapshot;
  annotations: AnnotationFile;
  lang: ExportLocale;
}

/**
 * Read the snapshot the exporter embedded in the document.
 *
 * This lives here rather than in `main.ts` so a spec can call it: importing
 * `main.ts` mounts the application as a side effect. It is the whole of the
 * contract with Task 6's Rust side, and the only thing in the emitted document
 * the bundle reads.
 */
export function readPayload(): ExportPayload {
  const node = document.querySelector("script[type='application/dbx-snapshot']");
  if (node === null) throw new Error("no <script type='application/dbx-snapshot'> in this document");
  // `atob` yields one byte per character; the payload is UTF-8, so it must be
  // widened before decoding or every non-ASCII table name and note is mangled.
  const binary = atob((node.textContent ?? "").trim());
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as ExportPayload;
}
