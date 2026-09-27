import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  addReferenceToConfig,
  type AddReferenceRequest,
  type ReferenceScope,
} from "./config-write";
import { synchronizeAllGitReferences } from "./git";
import type { ResolvedReference } from "./types";

const STATUS_KEY = "pi-references";
const ADD_USAGE = "Usage: /references add [--global] <alias> <path-or-repository> [branch]";
const SYNC_USAGE = "Usage: /references sync [alias]";

export function registerReferenceCommands(
  pi: ExtensionAPI,
  references: ResolvedReference[],
): void {
  pi.registerCommand("references", {
    description: "Manage pi-references entries",
    getArgumentCompletions: (argumentPrefix) =>
      getReferenceArgumentCompletions(argumentPrefix, references),
    handler: (args, ctx) => handleReferencesCommand(args, ctx, pi, references),
  });
}

type ParsedCommand =
  | { kind: "add"; request: AddReferenceRequest }
  | { kind: "sync"; alias?: string }
  | { kind: "interactive" }
  | { kind: "error"; message: string };

function tokenizeCommandArgs(input: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let tokenStarted = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaped || quote) {
    return undefined;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

function getReferenceArgumentCompletions(
  argumentPrefix: string,
  references: readonly ResolvedReference[],
): AutocompleteItem[] | null {
  const tokens = tokenizeCommandArgs(argumentPrefix);
  if (!tokens) {
    return null;
  }

  const trailingSpace = /\s$/.test(argumentPrefix);
  const current = trailingSpace ? "" : tokens.at(-1) ?? "";
  const completed = trailingSpace ? tokens : tokens.slice(0, -1);

  if (completed.length === 0) {
    return ["add", "sync"]
      .filter((value) => value.startsWith(current))
      .map((value) => ({ value, label: value }));
  }

  if (completed[0] === "add") {
    if (completed.length === 1 && (trailingSpace || current.startsWith("-"))) {
      return "--global".startsWith(current) ? [{ value: "--global", label: "--global" }] : null;
    }
    return null;
  }

  if (completed[0] === "sync" && completed.length === 1) {
    return references
      .filter((reference) => reference.kind === "git")
      .filter((reference) => reference.alias.startsWith(current))
      .map((reference) => ({
        value: reference.alias,
        label: reference.alias,
        description: reference.description ?? reference.repository,
      }));
  }

  return null;
}

function parseReferencesCommand(args: string): ParsedCommand {
  if (!args.trim()) {
    return { kind: "interactive" };
  }

  const tokens = tokenizeCommandArgs(args);
  if (!tokens) {
    return { kind: "error", message: `${ADD_USAGE} or ${SYNC_USAGE}` };
  }

  if (tokens[0] === "sync") {
    const remaining = tokens.slice(1);
    if (remaining.length > 1) {
      return { kind: "error", message: SYNC_USAGE };
    }
    return { kind: "sync", alias: remaining[0] };
  }

  if (tokens[0] !== "add") {
    return { kind: "error", message: `${ADD_USAGE} or ${SYNC_USAGE}` };
  }

  let index = 1;
  let scope: ReferenceScope = "project";
  if (tokens[index] === "--global") {
    scope = "global";
    index++;
  }

  const remaining = tokens.slice(index);
  if (remaining.length < 2 || remaining.length > 3) {
    return { kind: "error", message: ADD_USAGE };
  }

  const [alias, source, branch] = remaining;
  return {
    kind: "add",
    request: {
      alias,
      source,
      branch,
      scope,
    },
  };
}

async function promptAddReference(
  ctx: ExtensionCommandContext,
): Promise<AddReferenceRequest | undefined> {
  if (!ctx.hasUI) {
    return undefined;
  }

  const alias = (await ctx.ui.input("Reference alias", "sdk"))?.trim();
  if (!alias) {
    return undefined;
  }

  const source = (await ctx.ui.input("Path or repository", "OWNER/repository"))?.trim();
  if (!source) {
    return undefined;
  }

  const branch = (await ctx.ui.input("Branch (optional)", "main"))?.trim();
  return {
    alias,
    source,
    branch: branch || undefined,
    scope: "project",
  };
}

function setReferenceStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
  ctx.ui.setStatus?.(STATUS_KEY, text);
}

async function handleSyncCommand(
  alias: string | undefined,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  references: readonly ResolvedReference[],
): Promise<void> {
  let selected = references.filter((reference) => reference.kind === "git");
  if (alias) {
    const reference = references.find((item) => item.alias === alias);
    if (!reference) {
      ctx.ui.notify(`Unknown reference "${alias}"`, "warning");
      return;
    }
    if (reference.kind !== "git") {
      ctx.ui.notify(`Reference "${alias}" is not a Git reference`, "warning");
      return;
    }
    selected = [reference];
  }

  if (selected.length === 0) {
    ctx.ui.notify("No Git references configured", "info");
    return;
  }

  setReferenceStatus(ctx, `Syncing ${alias ?? "Git references"}…`);
  try {
    const results = await synchronizeAllGitReferences(pi, selected, { signal: ctx.signal });
    const failures = results.filter((result) => result.action === "failed");
    if (failures.length > 0) {
      const details = failures
        .map((result) => `${result.alias}: ${result.warning ?? "sync failed"}`)
        .join("; ");
      ctx.ui.notify(`Git references not synchronized: ${details}`, "warning");
      return;
    }
    ctx.ui.notify(`Synchronized ${results.length} Git reference${results.length === 1 ? "" : "s"}`, "info");
  } finally {
    setReferenceStatus(ctx, undefined);
  }
}

async function handleReferencesCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  references: readonly ResolvedReference[],
): Promise<void> {
  const parsed = parseReferencesCommand(args);
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }

  if (parsed.kind === "sync") {
    await handleSyncCommand(parsed.alias, ctx, pi, references);
    return;
  }

  const request = parsed.kind === "interactive" ? await promptAddReference(ctx) : parsed.request;
  if (!request) {
    ctx.ui.notify(ADD_USAGE, "warning");
    return;
  }

  try {
    const result = await addReferenceToConfig(ctx.cwd, request);
    ctx.ui.notify(
      `Reference "${request.alias}" saved in ${result.configPath}. Run /reload to apply it.`,
      "info",
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-references: ${message}`, "error");
  }
}
