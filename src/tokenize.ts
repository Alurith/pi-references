export type ReferenceQuery = {
  aliasQuery: string;
  pathQuery?: string;
  prefix: string;
};

export type ReferenceToken = {
  alias: string;
  rawPath?: string;
  full: string;
  token: string;
  trailing: string;
  start: number;
  end: number;
};

const TOKEN_BOUNDARY_RE = /(^|[\s([{'"])@([A-Za-z0-9][A-Za-z0-9._-]*)(\/[^\s`]*)?/g;
const CURSOR_BOUNDARY_RE = /(^|[\s([{'"])@([A-Za-z0-9._-]*)(\/[^\s`]*)?$/;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]*$/;

function splitTrailing(full: string, alias: string, rawPath: string | undefined): ReferenceToken {
  const trailing = rawPath ? full.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "" : "";
  const token = trailing ? full.slice(0, -trailing.length) : full;

  return {
    // Dots and hyphens are valid alias characters. Only path suffixes use
    // punctuation splitting; otherwise @docs. remains one alias token.
    alias,
    rawPath: rawPath && trailing ? rawPath.slice(0, -trailing.length) : rawPath,
    full,
    token,
    trailing,
    start: 0,
    end: 0,
  };
}

export function parseReferenceQueryAtCursor(textBeforeCursor: string): ReferenceQuery | undefined {
  const match = textBeforeCursor.match(CURSOR_BOUNDARY_RE);
  if (!match) {
    return undefined;
  }

  const alias = match[2] ?? "";
  const rawPath = match[3];
  if (rawPath === undefined) {
    return { aliasQuery: alias, prefix: `@${alias}` };
  }

  return {
    aliasQuery: alias,
    pathQuery: rawPath.slice(1),
    prefix: `@${alias}${rawPath}`,
  };
}

export function findReferenceTokens(text: string): ReferenceToken[] {
  const tokens: ReferenceToken[] = [];

  for (const match of text.matchAll(TOKEN_BOUNDARY_RE)) {
    const boundary = match[1] ?? "";
    const alias = match[2] ?? "";
    const rawPath = match[3];
    const full = `@${alias}${rawPath ?? ""}`;
    const start = (match.index ?? 0) + boundary.length;
    const token = splitTrailing(full, alias, rawPath);

    if (!token.alias) {
      continue;
    }

    tokens.push({
      ...token,
      start,
      end: start + full.length,
    });
  }

  return tokens;
}
