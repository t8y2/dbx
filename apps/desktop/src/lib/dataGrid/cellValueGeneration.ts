import { uuid } from "@/lib/common/utils";

export type CellValueGenerationKind = "empty" | "null" | "datetime" | "date" | "uuid" | "increment" | "snowflake";

export interface SnowflakeIdGenerator {
  next(nowMs?: number): string;
}

const SNOWFLAKE_EPOCH_MS = 1_609_459_200_000;
const SNOWFLAKE_MAX_SEQUENCE = 4095n;

export function createSnowflakeIdGenerator(options: { workerId?: number; now?: () => number } = {}): SnowflakeIdGenerator {
  const workerId = options.workerId ?? Math.floor(Math.random() * 1024);
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) throw new RangeError("Snowflake workerId must be between 0 and 1023");

  const now = options.now ?? Date.now;
  let lastTimestampMs = -1;
  let sequence = 0n;

  return {
    next(nowMs = now()) {
      let timestampMs = Math.max(Math.trunc(nowMs), SNOWFLAKE_EPOCH_MS);
      if (timestampMs < lastTimestampMs) timestampMs = lastTimestampMs;
      if (timestampMs === lastTimestampMs) {
        sequence += 1n;
        if (sequence > SNOWFLAKE_MAX_SEQUENCE) {
          timestampMs += 1;
          sequence = 0n;
        }
      } else {
        sequence = 0n;
      }
      lastTimestampMs = timestampMs;
      return (((BigInt(timestampMs) - BigInt(SNOWFLAKE_EPOCH_MS)) << 22n) | (BigInt(workerId) << 12n) | sequence).toString();
    },
  };
}

const defaultSnowflakeIdGenerator = createSnowflakeIdGenerator();

export function generateCellValues(
  kind: CellValueGenerationKind,
  count: number,
  options: {
    now?: Date;
    startValue?: bigint;
    uuidFactory?: () => string;
    snowflakeGenerator?: SnowflakeIdGenerator;
  } = {},
): Array<string | null> {
  const size = Math.max(0, Math.trunc(count));
  const now = options.now ?? new Date();
  const uuidFactory = options.uuidFactory ?? uuid;
  const snowflakeGenerator = options.snowflakeGenerator ?? defaultSnowflakeIdGenerator;

  return Array.from({ length: size }, (_, index) => {
    if (kind === "null") return null;
    if (kind === "empty") return "";
    if (kind === "datetime") return localDateTimeText(now);
    if (kind === "date") return localDateText(now);
    if (kind === "uuid") return uuidFactory();
    if (kind === "increment") return String((options.startValue ?? 1n) + BigInt(index));
    return snowflakeGenerator.next(now.getTime());
  });
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateTimeText(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

function localDateText(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}
