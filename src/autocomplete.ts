import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { ResolvedReference } from "./types";

const MAX_SUGGESTIONS = 50;

function extractReferenceToken(textBeforeCursor: string): { aliasQuery: string; pathQuery?: string; prefix: string } | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])@([^\s@]*)$/);
  if (!match) {
    return undefined;
  }

  const token = match[1] ?? "";
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

function createAliasItem(reference: ResolvedReference): AutocompleteItem {
  return {
    value: `@${reference.alias}`,
    label: `@${reference.alias}`,
    description: reference.description ?? reference.resolvedPath ?? reference.repository,
  };
}

function listReferenceItems(reference: ResolvedReference, pathQuery: string): AutocompleteItem[] {
  if (!reference.resolvedPath) {
    return [];
  }

  const normalized = pathQuery.replace(/^\/+/, "");
  const segments = normalized.split("/");
  const partial = segments.pop() ?? "";
  const baseRelative = segments.filter(Boolean).join("/");
  const baseDir = join(reference.resolvedPath, baseRelative);

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.name.toLowerCase().startsWith(partial.toLowerCase()))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => {
      const relative = [baseRelative, entry.name].filter(Boolean).join("/");
      const value = `@${reference.alias}/${relative}${entry.isDirectory() ? "/" : ""}`;
      return {
        value,
        label: value,
        description: entry.isDirectory() ? "directory" : "file",
      } satisfies AutocompleteItem;
    });
}

export function createReferencesAutocompleteProvider(
  references: ResolvedReference[],
): (current: AutocompleteProvider) => AutocompleteProvider {
  const visibleReferences = references.filter((reference) => !reference.hidden);

  return (current) => ({
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const token = extractReferenceToken(textBeforeCursor);
      if (!token) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (token.pathQuery === undefined) {
        const items = visibleReferences
          .filter((reference) => reference.alias.toLowerCase().includes(token.aliasQuery.toLowerCase()))
          .slice(0, MAX_SUGGESTIONS)
          .map(createAliasItem);

        if (items.length === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        return { prefix: token.prefix, items };
      }

      const reference = references.find((item) => item.alias === token.aliasQuery);
      if (!reference || reference.hidden) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = listReferenceItems(reference, token.pathQuery);
      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { prefix: token.prefix, items };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  });
}
