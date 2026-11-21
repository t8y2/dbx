// Expected positions are explicit: surviving lines follow their content; a
// replaced/deleted line uses CodeMirror's replacement-boundary fallback.
export const workspaceBookmarkCases = [
  { name: "adjacent edited lines", before: "select a;\nselect b;\nselect c;", after: "select aa;\nselect bb;\nselect cc;", saved: [1, 2, 3], expected: [1, 2, 3] },
  { name: "separated insertions", before: "a\nb\nc\nd", after: "new\na\nb\nmid\nc\nd", saved: [1, 3], expected: [2, 5] },
  { name: "separated deletions", before: "new\na\nb\nmid\nc\nd", after: "a\nb\nc\nd", saved: [2, 5], expected: [1, 3] },
  { name: "repeated lines with context", before: "a\nrepeat\nb\nrepeat\nc", after: "new\na\nrepeat\nb\nmid\nrepeat\nc", saved: [2, 4], expected: [3, 6] },
  { name: "ambiguous repeated-line deletion", before: "repeat\nrepeat\nanchor", after: "repeat\nanchor", saved: [1, 2], expected: [1, 2] },
  { name: "full document replacement", before: "a\nb\nc", after: "x\ny", saved: [1, 2, 3], expected: [1, 2] },
];
