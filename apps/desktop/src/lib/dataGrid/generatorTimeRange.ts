const SECONDS_PER_DAY = 24 * 60 * 60;

function timeBoundSeconds(value: string | undefined, upper: boolean): number {
  const fallback = upper ? SECONDS_PER_DAY - 1 : 0;
  const match = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?$/.exec(value?.trim() ?? "");
  if (!match) return fallback;
  const hour = Number(match[1]);
  // Older saved configurations contain hours only; retain their whole-hour
  // upper bound. Values from the time inputs are exact clock-time bounds.
  const minute = match[2] === undefined ? (upper ? 59 : 0) : Number(match[2]);
  const second = match[2] === undefined ? (upper ? 59 : 0) : Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return fallback;
  return hour * 3600 + minute * 60 + second;
}

export function generateTimeInRange(start?: string, end?: string): string {
  const startSeconds = timeBoundSeconds(start, false);
  const endSeconds = timeBoundSeconds(end, true);
  const lower = Math.min(startSeconds, endSeconds);
  const upper = Math.max(startSeconds, endSeconds);
  const seconds = lower + Math.floor(Math.random() * (upper - lower + 1));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}
