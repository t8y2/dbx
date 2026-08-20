import type { AiCsvFileContext, AiTextAttachmentEncoding, AiTextAttachmentResolvedEncoding } from "@/lib/ai/ai";

export const AI_TEXT_ATTACHMENT_MAX_BYTES = 48 * 1024;
export const AI_TEXT_ATTACHMENT_MAX_CHARS = 12_000;
export const AI_TEXT_ATTACHMENT_MAX_COUNT = 8;
export const AI_TEXT_ATTACHMENT_MAX_TOTAL_CHARS = 32_000;
export const AI_IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const AI_IMAGE_ATTACHMENT_MAX_COUNT = 4;
export const AI_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

export const AI_TEXT_ATTACHMENT_EXTENSIONS = new Set(["csv", "md", "markdown", "txt", "text", "json", "yaml", "yml", "xml", "log", "tsv"]);
export const AI_IMAGE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const AI_IMAGE_ATTACHMENT_TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface AttachmentImageBudgetItem {
  sizeBytes: number;
}

export type AttachmentBudgetError = "count" | "total";
export type ImageAttachmentSupportError = "provider" | "format";

interface AiModelInstructionInput {
  tableMentionRaws: readonly string[];
  sqlFileMentionRaws: readonly string[];
  userText: string;
}

/**
 * Build model-facing instructions from explicit user input and reference
 * mentions only. Attachment metadata belongs to the untrusted attachment data
 * block and must not be promoted into the instruction or task contract.
 */
export function buildAiModelInstruction(input: AiModelInstructionInput): string {
  return [input.tableMentionRaws.join(" "), input.sqlFileMentionRaws.join(" "), input.userText].filter(Boolean).join(" ");
}

export function attachmentExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function imageAttachmentMediaType(file: Pick<File, "name" | "type">): string | undefined {
  const mediaType = file.type.toLowerCase();
  if (AI_IMAGE_ATTACHMENT_TYPES.has(mediaType)) return mediaType;
  return AI_IMAGE_ATTACHMENT_TYPES_BY_EXTENSION[attachmentExtension(file.name)];
}

/**
 * Report whether DBX has an image-capable transport for this provider.
 * Model capability is intentionally left to the provider instead of being
 * guessed from model names, which change independently of the application.
 */
export function imageProviderSupportsAttachments(provider?: string): boolean {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (!normalizedProvider) return false;
  // API transports all serialize structured image parts. Among CLI transports,
  // only Codex currently exposes a native image argument.
  return normalizedProvider === "codex-cli" || !normalizedProvider.endsWith("-cli");
}

export function imageAttachmentMediaTypeSupported(provider: string | undefined, mediaType: string): boolean {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (!AI_IMAGE_ATTACHMENT_TYPES.has(mediaType)) return false;
  // Gemini image understanding accepts PNG, JPEG and WebP, but not GIF.
  if (normalizedProvider === "gemini") return mediaType !== "image/gif";
  return true;
}

export function imageAttachmentSupportError(provider: string | undefined, mediaTypes: readonly string[]): ImageAttachmentSupportError | undefined {
  if (!mediaTypes.length) return undefined;
  if (!imageProviderSupportsAttachments(provider)) return "provider";
  if (mediaTypes.some((mediaType) => !imageAttachmentMediaTypeSupported(provider, mediaType))) return "format";
  return undefined;
}

function decodeAttachmentBytes(bytes: Uint8Array, encoding: string, truncated: boolean): string {
  const decoder = new TextDecoder(encoding, { fatal: true });
  return decoder.decode(bytes, { stream: truncated });
}

const TEXT_ATTACHMENT_DECODER_LABELS: Record<AiTextAttachmentResolvedEncoding, string> = {
  utf8: "utf-8",
  gbk: "gbk",
  utf16Le: "utf-16le",
  utf16Be: "utf-16be",
};

function textAttachmentBom(bytes: Uint8Array): { encoding: AiTextAttachmentResolvedEncoding; length: number } | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf8", length: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf16Le", length: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf16Be", length: 2 };
  return undefined;
}

/** Resolve the decoder separately so the UI can expose and override ambiguous auto-detection. */
export function resolveTextAttachmentEncoding(bytes: Uint8Array, requested: AiTextAttachmentEncoding = "auto", truncated = false): AiTextAttachmentResolvedEncoding {
  if (requested !== "auto") return requested;
  const bom = textAttachmentBom(bytes);
  if (bom) return bom.encoding;
  try {
    decodeAttachmentBytes(bytes, "utf-8", truncated);
    return "utf8";
  } catch {
    return "gbk";
  }
}

/** Decode common database-export encodings without silently replacing bytes. */
export function decodeTextAttachmentBytes(bytes: Uint8Array, truncated = false, requested: AiTextAttachmentEncoding = "auto"): string {
  const encoding = resolveTextAttachmentEncoding(bytes, requested, truncated);
  const bom = textAttachmentBom(bytes);
  const contentBytes = bom?.encoding === encoding ? bytes.subarray(bom.length) : bytes;
  // The Encoding Standard maps the `gbk` label to the GB18030 decoder.
  return decodeAttachmentBytes(contentBytes, TEXT_ATTACHMENT_DECODER_LABELS[encoding], truncated);
}

export function priorAttachmentHistoryNote(hasOmittedAttachments: boolean): string {
  return hasOmittedAttachments ? "[Prior-turn attachment content is not repeated in this request.]" : "";
}

/** Create an isolated edit draft so cancelling cannot mutate model history. */
export function cloneTextAttachmentForEdit(attachment: AiCsvFileContext): AiCsvFileContext {
  return { ...attachment };
}

interface AttachmentByteReader {
  read(buffer: Uint8Array): Promise<number | null>;
}

/** Read only the bounded prefix needed for model context, handling partial file reads. */
export async function readTextAttachmentPrefix(reader: AttachmentByteReader, sourceSize: number): Promise<Uint8Array> {
  const safeSize = Number.isFinite(sourceSize) ? Math.max(0, Math.floor(sourceSize)) : 0;
  const bytes = new Uint8Array(Math.min(safeSize, AI_TEXT_ATTACHMENT_MAX_BYTES));
  let offset = 0;
  while (offset < bytes.length) {
    const read = await reader.read(bytes.subarray(offset));
    if (read == null || read === 0) break;
    if (read < 0 || read > bytes.length - offset) throw new Error("Invalid attachment read length");
    offset += read;
  }
  return offset === bytes.length ? bytes : bytes.slice(0, offset);
}

/** Truncate within the existing UTF-16 budget without splitting a surrogate pair. */
export function truncateTextAttachmentContent(content: string, maxChars: number): string {
  const truncated = content.slice(0, Math.max(0, maxChars));
  if (truncated.length === content.length) return truncated;
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

export function textAttachmentBudgetError(existing: readonly AiCsvFileContext[]): AttachmentBudgetError | undefined {
  if (existing.length >= AI_TEXT_ATTACHMENT_MAX_COUNT) return "count";
  if (existing.reduce((total, attachment) => total + attachment.content.length, 0) >= AI_TEXT_ATTACHMENT_MAX_TOTAL_CHARS) return "total";
  return undefined;
}

export function remainingTextAttachmentChars(existing: readonly AiCsvFileContext[]): number {
  const used = existing.reduce((total, attachment) => total + attachment.content.length, 0);
  return Math.max(0, Math.min(AI_TEXT_ATTACHMENT_MAX_CHARS, AI_TEXT_ATTACHMENT_MAX_TOTAL_CHARS - used));
}

export function imageAttachmentBudgetError(existing: readonly AttachmentImageBudgetItem[], nextSizeBytes: number): AttachmentBudgetError | undefined {
  if (existing.length >= AI_IMAGE_ATTACHMENT_MAX_COUNT) return "count";
  const total = existing.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (total + nextSizeBytes > AI_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) return "total";
  return undefined;
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

interface DropPosition {
  x: number;
  y: number;
}

interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function physicalDropPositionInsideRect(position: DropPosition | undefined, rect: DropRect, scaleFactor: number): boolean {
  if (!position) return false;
  const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const x = position.x / safeScale;
  const y = position.y / safeScale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
