import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReferencesAutocompleteProvider } from "./src/autocomplete";
import { loadReferences } from "./src/config";
import {
  assignGitCachePaths,
  materializeGitReference,
  synchronizeAllGitReferences,
} from "./src/git";
import { registerReferenceCommands } from "./src/commands";
import { expandReferencesInText, getReferencedAliases } from "./src/transform";
import type { ResolvedReference } from "./src/types";

let currentReferences: ResolvedReference[] = [];

function sanitizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 500);
}

function buildSystemPromptSection(references: ResolvedReference[]): string {
  const described = references.filter((reference) => reference.description && reference.resolvedPath);
  if (described.length === 0) {
    return "";
  }

  const lines = ["", "Available references:"];
  for (const reference of described) {
    const description = sanitizeDescription(reference.description ?? "");
    lines.push(`- ${reference.alias} -> ${reference.resolvedPath}`);
    lines.push(`  ${description}`);
  }
  lines.push("When the user writes @alias or @alias/path, treat it as a configured reference. If a [resolved: ...] suffix is present, use that resolved filesystem path with tools.");
  return lines.join("\n");
}

function referencesByAlias(references: ResolvedReference[]): Map<string, ResolvedReference> {
  return new Map(references.map((reference) => [reference.alias, reference]));
}

export default function (pi: ExtensionAPI) {
  registerReferenceCommands(pi);

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadReferences(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
    currentReferences = loaded.references;
    assignGitCachePaths(currentReferences);

    for (const warning of loaded.warnings) {
      ctx.ui.notify(`pi-references: ${warning}`, "error");
    }

    const ensureReferenceAvailable = async (reference: ResolvedReference): Promise<void> => {
      if (reference.kind !== "git") {
        return;
      }

      const warning = await materializeGitReference(pi, reference);
      if (warning) {
        ctx.ui.notify(`pi-references: ${warning}`, "error");
      }
    };

    ctx.ui.addAutocompleteProvider(createReferencesAutocompleteProvider(currentReferences, ensureReferenceAvailable));

    // Clone and refresh all configured Git references in the background. Do not
    // await this promise: Pi should finish startup while Git works asynchronously.
    void synchronizeAllGitReferences(pi, currentReferences)
      .then((results) => {
        const failures = results.filter((result) => result.action === "failed");
        if (failures.length === 0) {
          return;
        }

        const aliases = failures.map((result) => result.alias).join(", ");
        ctx.ui.notify(`Git references not synchronized: ${aliases}`, "warning");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-references: background Git sync failed: ${message}`, "warning");
      });
  });

  pi.on("input", async (event, ctx) => {
    if (currentReferences.length === 0) {
      return { action: "continue" as const };
    }

    const byAlias = referencesByAlias(currentReferences);
    for (const alias of getReferencedAliases(event.text)) {
      const reference = byAlias.get(alias);
      if (!reference || reference.kind !== "git") {
        continue;
      }

      const warning = await materializeGitReference(pi, reference);
      if (warning) {
        ctx.ui.notify(`pi-references: ${warning}`, "error");
      }
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
