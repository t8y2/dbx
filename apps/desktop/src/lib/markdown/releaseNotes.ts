import { Marked } from "marked";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const marked = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>` : text;
    },
    image: ({ text }) => escapeHtml(text),
  },
});

export function renderReleaseNotes(notes: string): string {
  if (!notes.trim()) return "";

  try {
    return marked.parse(notes) as string;
  } catch {
    return escapeHtml(notes);
  }
}
