import { join } from "node:path";
import type { ResolvedReference } from "./types";

const REFERENCE_TOKEN_RE = /@([^/\s`,]+)(\/[^\s`]*)?/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]*$/;

function resolveTokenPath(reference: ResolvedReference, rawPath: string | undefined): string | undefined {
  if (!reference.resolvedPath) {
    return undefined;
  }

  if (!rawPath || rawPath === "/") {
    return reference.resolvedPath;
  }

  return join(reference.resolvedPath, rawPath.replace(/^\//, ""));
}

export function expandReferencesInText(text: string, references: ResolvedReference[]): string {
  const byAlias = new Map(references.map((reference) => [reference.alias, reference]));

  return text.replace(REFERENCE_TOKEN_RE, (fullMatch, alias: string, rawPath?: string) => {
    const trailing = fullMatch.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
    const token = trailing ? fullMatch.slice(0, -trailing.length) : fullMatch;
    const cleanAlias = trailing && !rawPath ? alias.slice(0, -trailing.length) : alias;
    const cleanRawPath = rawPath && trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    const reference = byAlias.get(cleanAlias);
    if (!reference) {
      return fullMatch;
    }

    const resolved = resolveTokenPath(reference, cleanRawPath);
    if (!resolved) {
      return fullMatch;
    }

    return `${token} [resolved: ${resolved}]${trailing}`;
  });
}
