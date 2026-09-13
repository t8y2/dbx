const DATE_TOKEN_RE = /^\{\{(today|yesterday|tomorrow|now)\}\}$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Resolves a dynamic default token (`{{today}}`, `{{yesterday}}`,
 *  `{{tomorrow}}`, `{{now}}`) to a concrete value so the runner shows a real
 *  date. Non-token input is returned unchanged. Kept in sync with the
 *  backend resolver in dbx-core/data_view_params.rs. */
export function resolveDynamicDefault(value: string | null | undefined, now = new Date()): string {
  if (!value) return "";
  const match = value.trim().match(DATE_TOKEN_RE);
  if (!match) return value;
  const date = new Date(now);
  switch (match[1]) {
    case "yesterday":
      date.setDate(date.getDate() - 1);
      return formatDate(date);
    case "tomorrow":
      date.setDate(date.getDate() + 1);
      return formatDate(date);
    case "now":
      return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    default:
      return formatDate(date);
  }
}
