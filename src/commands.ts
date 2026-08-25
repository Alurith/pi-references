import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  addReferenceToConfig,
  type AddReferenceRequest,
  type ReferenceScope,
} from "./config-write";

export function registerReferenceCommands(pi: ExtensionAPI): void {
  pi.registerCommand("references", {
    description: "Add a pi-references entry",
    handler: handleReferencesCommand,
  });
}

type ParsedCommand =
  | { kind: "add"; request: AddReferenceRequest }
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

function parseReferencesCommand(args: string): ParsedCommand {
  if (!args.trim()) {
    return { kind: "interactive" };
  }

  const tokens = tokenizeCommandArgs(args);
  if (!tokens || tokens[0] !== "add") {
    return {
      kind: "error",
      message: "Usage: /references add [--global] <alias> <path-or-repository> [branch]",
    };
  }

  let index = 1;
  let scope: ReferenceScope = "project";
  if (tokens[index] === "--global") {
    scope = "global";
    index++;
  }

  const remaining = tokens.slice(index);
  if (remaining.length < 2 || remaining.length > 3) {
    return {
      kind: "error",
      message: "Usage: /references add [--global] <alias> <path-or-repository> [branch]",
    };
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

async function handleReferencesCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseReferencesCommand(args);
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }

  const request = parsed.kind === "interactive" ? await promptAddReference(ctx) : parsed.request;
  if (!request) {
    ctx.ui.notify("Usage: /references add <alias> <path-or-repository> [branch]", "warning");
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
