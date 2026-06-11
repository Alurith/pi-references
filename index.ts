import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReferencesAutocompleteProvider } from "./src/autocomplete";
import { loadReferences } from "./src/config";
import { materializeGitReferences } from "./src/git";
import { expandReferencesInText } from "./src/transform";
import type { ResolvedReference } from "./src/types";

let currentReferences: ResolvedReference[] = [];

function buildSystemPromptSection(references: ResolvedReference[]): string {
  const described = references.filter((reference) => reference.description && reference.resolvedPath);
  if (described.length === 0) {
    return "";
  }

  const lines = ["", "Available references:"];
  for (const reference of described) {
    lines.push(`- ${reference.alias} -> ${reference.resolvedPath}`);
    lines.push(`  ${reference.description}`);
  }
  lines.push("When the user writes @alias or @alias/path, treat it as a configured reference. If a [resolved: ...] suffix is present, use that resolved filesystem path with tools.");
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadReferences(ctx.cwd);
    currentReferences = loaded.references;

    const gitWarnings = await materializeGitReferences(pi, currentReferences);

    for (const warning of [...loaded.warnings, ...gitWarnings]) {
      ctx.ui.notify(`pi-references: ${warning}`, "error");
    }

    ctx.ui.addAutocompleteProvider(createReferencesAutocompleteProvider(currentReferences));
  });

  pi.on("input", async (event) => {
    if (currentReferences.length === 0) {
      return { action: "continue" as const };
    }

    const transformedText = expandReferencesInText(event.text, currentReferences);
    if (transformedText === event.text) {
      return { action: "continue" as const };
    }

    return {
      action: "transform" as const,
      text: transformedText,
      images: event.images,
    };
  });

  pi.on("before_agent_start", async (event) => {
    const section = buildSystemPromptSection(currentReferences);
    if (!section) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}${section}`,
    };
  });
}
