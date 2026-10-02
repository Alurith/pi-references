import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReferencesAutocompleteProvider } from "./src/autocomplete.ts";
import { loadReferences } from "./src/config.ts";
import {
  materializeGitReference,
  synchronizeAllGitReferences,
} from "./src/git.ts";
import { registerReferenceCommands } from "./src/commands.ts";
import { expandReferencesInText, getReferencedAliases } from "./src/transform.ts";
import type { ResolvedReference } from "./src/types.ts";

let currentReferences: ResolvedReference[] = [];
let sessionAbortController: AbortController | undefined;
let sessionGeneration = 0;
const sessionSyncPromises = new Set<Promise<void>>();
let autocompleteRegistered = false;

function sanitizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 500);
}

const MAX_PROMPT_SECTION_CHARS = 12_000;
const REFERENCE_SYSTEM_PROMPT_SECTION = "pi-references";

function buildSystemPromptSection(references: ResolvedReference[]): string {
  const described = references.filter((reference) => reference.description && reference.resolvedPath);
  if (described.length === 0) {
    return "";
  }

  const lines = ["Available references:"];
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

export default function (pi: ExtensionAPI) {
  registerReferenceCommands(pi, currentReferences);

  pi.on("session_start", (_event, ctx) => {
    sessionAbortController?.abort();
    const controller = new AbortController();
    sessionAbortController = controller;
    const generation = ++sessionGeneration;

    const loaded = loadReferences(ctx.cwd, ctx.isProjectTrusted());
    currentReferences.splice(0, currentReferences.length, ...loaded.references);

    for (const warning of loaded.warnings) {
      ctx.ui.notify(`pi-references: ${warning}`, "error");
    }

    const ensureReferenceAvailable = async (reference: ResolvedReference, signal?: AbortSignal): Promise<void> => {
      if (reference.kind !== "git" || controller.signal.aborted || signal?.aborted) {
        return;
      }

      const warning = await materializeGitReference(pi, reference, { signal: signal ?? controller.signal });
      if (warning && generation === sessionGeneration && !controller.signal.aborted && !signal?.aborted) {
        ctx.ui.notify(`pi-references: ${warning}`, "error");
      }
    };

    if (!autocompleteRegistered) {
      ctx.ui.addAutocompleteProvider(createReferencesAutocompleteProvider(currentReferences, ensureReferenceAvailable));
      autocompleteRegistered = true;
    }

    // Clone and refresh all configured Git references in the background. Do not
    // await this promise: Pi should finish startup while Git works asynchronously.
    const syncPromise = synchronizeAllGitReferences(pi, currentReferences, { signal: controller.signal })
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
    sessionSyncPromises.add(syncPromise);
    syncPromise.then(
      () => sessionSyncPromises.delete(syncPromise),
      () => sessionSyncPromises.delete(syncPromise),
    );
  });

  pi.on("session_shutdown", async () => {
    sessionAbortController?.abort();
    sessionAbortController = undefined;
    sessionGeneration++;

    // Do not let the next session reuse a cache directory while any previous
    // Git operation is still cleaning up. Re-check in case a lifecycle event
    // queued another sync before shutdown started.
    while (sessionSyncPromises.size > 0) {
      await Promise.allSettled([...sessionSyncPromises]);
    }

    currentReferences.splice(0, currentReferences.length);
    autocompleteRegistered = false;
  });

  pi.on("input", async (event, ctx) => {
    if (currentReferences.length === 0) {
      return { action: "continue" as const };
    }

    const inputGeneration = sessionGeneration;
    const inputSignal = sessionAbortController?.signal;
    const byAlias = new Map(currentReferences.map((reference) => [reference.alias, reference]));
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

    if (inputGeneration !== sessionGeneration || inputSignal?.aborted) {
      return { action: "continue" as const };
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

  pi.on("before_agent_start", (event) => {
    const section = buildSystemPromptSection(currentReferences);
    const sections = (
      event.systemPromptOptions as { sections?: Record<string, string> } | undefined
    )?.sections;
    if (sections) {
      if (section) {
        sections[REFERENCE_SYSTEM_PROMPT_SECTION] = section;
      } else {
        delete sections[REFERENCE_SYSTEM_PROMPT_SECTION];
      }
      return;
    }

    // Pi 0.84–0.85 exposes systemPromptOptions but not structured sections.
    if (section) {
      return { systemPrompt: `${event.systemPrompt}\n${section}` };
    }
    return undefined;
  });
}
