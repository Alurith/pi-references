export type ReferenceQuery = {
  aliasQuery: string;
  pathQuery?: string;
  prefix: string;
};

export type ReferenceToken = {
  alias: string;
  rawPath?: string;
  token: string;
  trailing: string;
  start: number;
  end: number;
};

const TOKEN_BOUNDARY_RE = /(^|[\s([{'"<`，．：；！？（）［］｛｝“”‘’…—])@(?:("(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|([A-Za-z0-9][A-Za-z0-9._-]*)(\/[^\s`"'<>\[\]{}［］｛｝“”‘’（）]*)?)/g;
const CURSOR_BOUNDARY_RE = /(^|[\s([{'"<`，．：；！？（）［］｛｝“”‘’…—])@(?:"((?:\\[\s\S]|[^"\\])*)|([A-Za-z0-9._-]*)(\/[^\s`"'<>\[\]{}［］｛｝“”‘’（）]*)?)$/;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]*$/;

export function parseReferenceQueryAtCursor(textBeforeCursor: string): ReferenceQuery | undefined {
  const match = textBeforeCursor.match(CURSOR_BOUNDARY_RE);
  if (!match) return undefined;

  let alias = match[3] ?? "";
  let rawPath = match[4];
  if (match[2] !== undefined) {
    try {
      const decoded: string = JSON.parse(`"${match[2]}"`);
      const parts = decoded.match(/^([A-Za-z0-9._-]*)(\/[\s\S]*)?$/);
      if (!parts) return undefined;
      alias = parts[1];
      rawPath = parts[2];
    } catch {
      return undefined;
    }
  }

  return {
    aliasQuery: alias,
    ...(rawPath !== undefined ? { pathQuery: rawPath.slice(1) } : {}),
    prefix: match[0].slice((match[1] ?? "").length),
  };
}

export function findReferenceTokens(text: string): ReferenceToken[] {
  const tokens: ReferenceToken[] = [];

  for (const match of text.matchAll(TOKEN_BOUNDARY_RE)) {
    const boundary = match[1] ?? "";
    let alias = match[3] ?? "";
    let rawPath = match[4];
    const quoted = match[2];
    if (quoted !== undefined) {
      try {
        const decoded: string = JSON.parse(quoted);
        const parts = decoded.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\/[\s\S]*)?$/);
        if (!parts) continue;
        alias = parts[1];
        rawPath = parts[2];
      } catch {
        continue;
      }
    }

    const full = match[0].slice(boundary.length);
    const start = (match.index ?? 0) + boundary.length;
    // Alias dots and quoted filename punctuation are literal, not prose suffixes.
    const trailing = quoted === undefined && rawPath ? full.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "" : "";
    tokens.push({
      alias,
      rawPath: rawPath && trailing ? rawPath.slice(0, -trailing.length) : rawPath,
      token: trailing ? full.slice(0, -trailing.length) : full,
      trailing,
      start,
      end: start + full.length,
    });
  }

  return tokens;
}
