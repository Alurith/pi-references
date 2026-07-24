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
let sessionAbortController: AbortController | undefined;
let sessionGeneration = 0;
let autocompleteRegistered = false;

function sanitizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 500);
}

const MAX_PROMPT_SECTION_CHARS = 12_000;

function buildSystemPromptSection(references: ResolvedReference[]): string {
  const described = references.filter((reference) => reference.description && reference.resolvedPath);
  if (described.length === 0) {
    return "";
  }

  const lines = ["", "Available references:"];
  let currentLength = lines.join("\n").length;
  for (const reference of described) {
    const description = sanitizeDescription(reference.description ?? "");
    const candidate = [`- ${reference.alias} -> ${reference.resolvedPath}`, `  ${description}`];
    const candidateLength = candidate.join("\n").length + 1;
    if (currentLength + candidateLength > MAX_PROMPT_SECTION_CHARS) {
      break;
    }
    lines.push(...candidate);
    currentLength += candidateLength;
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
    sessionAbortController?.abort();
    const controller = new AbortController();
    sessionAbortController = controller;
    const generation = ++sessionGeneration;

    const loaded = loadReferences(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
    currentReferences.splice(0, currentReferences.length, ...loaded.references);
    assignGitCachePaths(currentReferences);

    for (const warning of loaded.warnings) {
      ctx.ui.notify(`pi-references: ${warning}`, "error");
    }

    const ensureReferenceAvailable = async (reference: ResolvedReference, signal?: AbortSignal): Promise<void> => {
      if (reference.kind !== "git" || controller.signal.aborted || signal?.aborted) {
        return;
      }

      const warning = await materializeGitReference(pi, reference, { signal: signal ?? controller.signal });
      if (warning && generation === sessionGeneration && !controller.signal.aborted) {
        ctx.ui.notify(`pi-references: ${warning}`, "error");
      }
    };

    if (!autocompleteRegistered) {
      ctx.ui.addAutocompleteProvider(createReferencesAutocompleteProvider(currentReferences, ensureReferenceAvailable));
      autocompleteRegistered = true;
    }

    // Clone and refresh all configured Git references in the background. Do not
    // await this promise: Pi should finish startup while Git works asynchronously.
    void synchronizeAllGitReferences(pi, currentReferences, { signal: controller.signal })
      .then((results) => {
        if (generation !== sessionGeneration || controller.signal.aborted) {
          return;
        }
        const failures = results.filter((result) => result.action === "failed");
        if (failures.length === 0) {
          return;
        }

        const aliases = failures.map((result) => result.alias).join(", ");
        ctx.ui.notify(`Git references not synchronized: ${aliases}`, "warning");
      })
      .catch((error: unknown) => {
        if (generation !== sessionGeneration || controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-references: background Git sync failed: ${message}`, "warning");
      });
  });

  pi.on("session_shutdown", () => {
    sessionAbortController?.abort();
    sessionAbortController = undefined;
    sessionGeneration++;
    currentReferences.splice(0, currentReferences.length);
    autocompleteRegistered = false;
  });

  pi.on("input", async (event, ctx) => {
    if (currentReferences.length === 0) {
      return { action: "continue" as const };
    }

    const inputGeneration = sessionGeneration;
    const inputSignal = sessionAbortController?.signal;
    const byAlias = referencesByAlias(currentReferences);
    const referencesToMaterialize = getReferencedAliases(event.text)
      .map((alias) => byAlias.get(alias))
      .filter((reference): reference is ResolvedReference => Boolean(reference && reference.kind === "git"));

    const results = await Promise.all(referencesToMaterialize.map(async (reference) => ({
      reference,
      warning: await materializeGitReference(pi, reference, { signal: inputSignal }),
    })));
    for (const { warning } of results) {
      if (warning && inputGeneration === sessionGeneration && !inputSignal?.aborted) {
        ctx.ui.notify(`pi-references: ${warning}`, "error");
      }
    }

    const transformedText = expandReferencesInText(event.text, currentReferences);
    if (transformedText === event.text) {
      return { action: "continue" as const };
    }

    const transformed = {
      action: "transform" as const,
      text: transformedText,
    };
    if (event.images) {
      return { ...transformed, images: event.images };
    }
    return transformed;
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
