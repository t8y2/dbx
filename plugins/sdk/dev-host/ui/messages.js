export function hostMessage(channel, message) {
  return JSON.parse(JSON.stringify({ ...message, source: "dbx-host", version: 1, channel }));
}

export function pluginInitMessage(frame, locale, theme, permissions) {
  return {
    type: "init",
    contributionId: frame.contributionId,
    context: JSON.parse(JSON.stringify(frame.context)),
    locale,
    theme,
    permissions,
  };
}
