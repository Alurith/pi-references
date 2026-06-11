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

const TOKEN_BOUNDARY_RE = /(^|[\s([{'"])@([^/\s`,]+)(\/[^\s`]*)?/g;
const CURSOR_BOUNDARY_RE = /(^|[\s([{'"])@([^\s@`]*)$/;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]*$/;

function splitTrailing(full: string, alias: string, rawPath: string | undefined): ReferenceToken {
  const trailing = full.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
  const token = trailing ? full.slice(0, -trailing.length) : full;

  return {
    alias: trailing && !rawPath ? alias.slice(0, -trailing.length) : alias,
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

  const token = match[2] ?? "";
  const slashIndex = token.indexOf("/");
  if (slashIndex === -1) {
    return { aliasQuery: token, prefix: `@${token}` };
  }

  return {
    aliasQuery: token.slice(0, slashIndex),
    pathQuery: token.slice(slashIndex + 1),
    prefix: `@${token}`,
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
