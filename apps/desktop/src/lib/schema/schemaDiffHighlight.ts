import { diffChars } from "diff";

export interface SchemaDiffHighlightSegment {
  text: string;
  changed: boolean;
}

export interface SchemaDiffHighlightSegments {
  sourceSegments: SchemaDiffHighlightSegment[];
  targetSegments: SchemaDiffHighlightSegment[];
}

export function buildSchemaDiffHighlightSegments(source: string, target: string): SchemaDiffHighlightSegments {
  const sourceSegments: SchemaDiffHighlightSegment[] = [];
  const targetSegments: SchemaDiffHighlightSegment[] = [];
  const changes = diffChars(source, target);
  const firstChangedIndex = changes.findIndex((change) => change.added || change.removed);
  let lastChangedIndex = -1;
  for (let index = changes.length - 1; index >= 0; index--) {
    if (changes[index].added || changes[index].removed) {
      lastChangedIndex = index;
      break;
    }
  }

  const append = (segments: SchemaDiffHighlightSegment[], text: string, changed: boolean) => {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous?.changed === changed) previous.text += text;
    else segments.push({ text, changed });
  };

  for (const [index, change] of changes.entries()) {
    if (change.removed) {
      append(sourceSegments, change.value, true);
    } else if (change.added) {
      append(targetSegments, change.value, true);
    } else {
      const betweenChanges = firstChangedIndex >= 0 && index > firstChangedIndex && index < lastChangedIndex;
      append(sourceSegments, change.value, betweenChanges);
      append(targetSegments, change.value, betweenChanges);
    }
  }

  return { sourceSegments, targetSegments };
}
