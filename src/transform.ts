import type { ResolvedReference } from "./types";
import { resolveInsideRoot } from "./resolve";
import { findReferenceTokens } from "./tokenize";

function resolveTokenPath(reference: ResolvedReference, rawPath: string | undefined): string | undefined {
  if (!reference.resolvedPath) {
    return undefined;
  }

  if (!rawPath || rawPath === "/") {
    return reference.resolvedPath;
  }

  return resolveInsideRoot(reference.resolvedPath, rawPath.replace(/^\//, ""));
}

export function getReferencedAliases(text: string): string[] {
  return Array.from(new Set(findReferenceTokens(text).map((token) => token.alias)));
}

export function expandReferencesInText(text: string, references: ResolvedReference[]): string {
  const byAlias = new Map(references.map((reference) => [reference.alias, reference]));
  const tokens = findReferenceTokens(text);

  let result = text;
  for (const token of tokens.reverse()) {
    const reference = byAlias.get(token.alias);
    if (!reference) {
      continue;
    }

    const resolved = resolveTokenPath(reference, token.rawPath);
    if (!resolved) {
      continue;
    }

    const replacement = `${token.token} [resolved: ${resolved}]${token.trailing}`;
    result = `${result.slice(0, token.start)}${replacement}${result.slice(token.end)}`;
  }

  return result;
}
