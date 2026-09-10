export function hostMessage(channel, message) {
  return JSON.parse(JSON.stringify({ ...message, source: "dbx-host", version: 1, channel }));
}
