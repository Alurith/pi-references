import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReferencesAutocompleteProvider } from "./src/autocomplete.ts";
import { loadReferences } from "./src/config.ts";
import {
  materializeGitReference,
  synchronizeAllGitReferences,
} from "./src/git.ts";
import { registerReferenceCommands } from "./src/commands.ts";
import { expandReferencesInText, getReferencedAliases } from "./src/transform.ts";
import type { ResolvedReference } from "./src/types.ts";

function sanitizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 500);
}

const MAX_PROMPT_SECTION_CHARS = 12_000;
const REFERENCE_SYSTEM_PROMPT_SECTION = "pi-references";
const AUTOMATIC_STATUS_KEY = "pi-references-automatic";

type ReferenceSession = {
  ctx: ExtensionContext;
  controller: AbortController;
  pending: Set<symbol>;
};

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
  const currentReferences: ResolvedReference[] = [];
  let session: ReferenceSession | undefined;
  const sessionSyncPromises = new Set<Promise<unknown>>();
  let autocompleteRegistered = false;

  function run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const sessionSignal = session?.controller.signal ?? AbortSignal.abort();
    const combined = signal ? AbortSignal.any([sessionSignal, signal]) : sessionSignal;
    const promise = operation(combined);
    sessionSyncPromises.add(promise);
    promise.then(() => sessionSyncPromises.delete(promise), () => sessionSyncPromises.delete(promise));
    return promise;
  }

  async function runWithStatus<T>(
    owner: ReferenceSession,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = Symbol();
    owner.pending.add(token);
    try {
      if (owner.pending.size === 1) owner.ctx.ui.setStatus?.(AUTOMATIC_STATUS_KEY, "Preparing Git references…");
      return await run(operation, signal);
    } finally {
      owner.pending.delete(token);
      if (session === owner && owner.pending.size === 0) owner.ctx.ui.setStatus?.(AUTOMATIC_STATUS_KEY, undefined);
    }
  }

  function retireSession(): void {
    const owner = session;
    if (!owner) return;
    session = undefined;
    owner.controller.abort();
    if (owner.pending.size > 0) owner.ctx.ui.setStatus?.(AUTOMATIC_STATUS_KEY, undefined);
  }

  function loadContext(ctx: ExtensionContext): void {
    const owner = session;
    if (!owner) return;
    const loaded = loadReferences(ctx.cwd, ctx.isProjectTrusted());
    const next = loaded.references.map((reference) => {
      const previous = currentReferences.find((item) => item.alias === reference.alias);
      if (previous?.kind === "git" && reference.kind === "git" && previous.repository === reference.repository && previous.branch === reference.branch && previous.referenceBaseDir === reference.referenceBaseDir) {
        previous.description = reference.description;
        previous.hidden = reference.hidden;
        return previous;
      }
      return reference;
    });
    const added = next.filter((reference) => !currentReferences.includes(reference));
    currentReferences.splice(0, currentReferences.length, ...next);

    for (const warning of loaded.warnings) {
      ctx.ui.notify(`pi-references: ${warning}`, "error");
    }

    if (!autocompleteRegistered) {
      ctx.ui.addAutocompleteProvider(createReferencesAutocompleteProvider(currentReferences, ensureAvailable));
      autocompleteRegistered = true;
    }

    // Clone and refresh all configured Git references in the background. Do not
    // await this promise: Pi should finish startup while Git works asynchronously.
    if (!added.some((reference) => reference.kind === "git")) return;
    const syncPromise = runWithStatus(owner, (signal) => synchronizeAllGitReferences(pi, added, { signal }))
      .then((results) => {
        if (session !== owner) {
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
        if (session !== owner) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-references: background Git sync failed: ${message}`, "warning");
      });
    void syncPromise;
  }

  async function ensureAvailable(reference: ResolvedReference, signal?: AbortSignal): Promise<void> {
    const owner = session;
    if (!owner || reference.kind !== "git" || !currentReferences.includes(reference) || signal?.aborted) return;
    const warning = await runWithStatus(owner, (combined) => materializeGitReference(pi, reference, { signal: combined }), signal);
    if (warning && session === owner && !signal?.aborted) {
      owner.ctx.ui.notify(`pi-references: ${warning}`, "error");
    }
  }

  registerReferenceCommands(pi, currentReferences, { reload: loadContext, run });

  pi.on("session_start", (_event, ctx) => {
    retireSession();
    session = { ctx, controller: new AbortController(), pending: new Set() };
    currentReferences.splice(0, currentReferences.length);
    loadContext(ctx);
  });

  pi.on("session_shutdown", async () => {
    retireSession();
    currentReferences.splice(0, currentReferences.length);
    autocompleteRegistered = false;
    await Promise.allSettled([...sessionSyncPromises]);
  });

  pi.on("input", async (event) => {
    const owner = session;
    if (!owner || currentReferences.length === 0) {
      return { action: "continue" as const };
    }

    const byAlias = new Map(currentReferences.map((reference) => [reference.alias, reference]));
    const referencesToMaterialize = getReferencedAliases(event.text)
      .map((alias) => byAlias.get(alias))
      .filter((reference): reference is ResolvedReference => Boolean(reference && reference.kind === "git"));

    await Promise.all(referencesToMaterialize.map((reference) => ensureAvailable(reference)));

    if (session !== owner) {
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
    const { sections } = event.systemPromptOptions;
    if (section) {
      sections[REFERENCE_SYSTEM_PROMPT_SECTION] = section;
    } else {
      delete sections[REFERENCE_SYSTEM_PROMPT_SECTION];
    }
  });
}
