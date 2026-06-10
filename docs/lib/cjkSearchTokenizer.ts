const asciiTokenPattern = /[a-z0-9_'-]+/gi;
const hanTokenPattern = /[\u3400-\u9fff]+/g;

function unique(tokens: string[]) {
  return Array.from(new Set(tokens.filter(Boolean)));
}

function tokenizeCjkText(input: string) {
  const source = input.toLowerCase();
  const tokens: string[] = [];

  for (const match of source.matchAll(asciiTokenPattern)) {
    tokens.push(match[0]);
  }

  for (const match of source.matchAll(hanTokenPattern)) {
    const text = match[0];
    tokens.push(text);

    for (const char of text) {
      tokens.push(char);
    }

    for (let index = 0; index < text.length - 1; index += 1) {
      tokens.push(text.slice(index, index + 2));
    }
  }

  return unique(tokens);
}

export function createCjkSearchTokenizer() {
  return {
    language: "cjk",
    normalizationCache: new Map<string, string>(),
    tokenize(raw: string) {
      if (typeof raw !== "string") return [raw];
      return tokenizeCjkText(raw);
    },
  };
}
