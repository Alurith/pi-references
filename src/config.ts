import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  GitReferenceConfig,
  LocalReferenceConfig,
  ReferenceConfigValue,
  ReferencesConfigFile,
  ReferenceSourceType,
  ResolvedReference,
} from "./types";
import { resolveReferencePath } from "./resolve";

const ALIAS_RE = /^[^/\s`,]+$/;
const GLOBAL_CONFIG_NAMES = ["references.json", "references.jsonc"];
const PROJECT_CONFIG_NAMES = ["references.json", "references.jsonc"];

type ConfigPath = {
  path: string;
  sourceType: ReferenceSourceType;
  referenceBaseDir: string;
};

export type LoadReferencesOptions = {
  includeProject?: boolean;
};

function isExplicitGitReference(value: string): boolean {
  return (
    /^git@/i.test(value) ||
    /^(https?:\/\/|ssh:\/\/|git:\/\/)/i.test(value) ||
    /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value)
  );
}

function looksLikeGitReference(value: string): boolean {
  return isExplicitGitReference(value) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") {
          output += "\n";
        }
        i++;
      }
      i++;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] ?? "")) {
        j++;
      }
      if (input[j] === "}" || input[j] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function readConfigFile(path: string): ReferencesConfigFile {
  const raw = readFileSync(path, "utf8");
  const normalized = stripTrailingCommas(stripJsonComments(raw));
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as ReferencesConfigFile;
}

function normalizeReference(
  alias: string,
  value: ReferenceConfigValue,
  sourceConfigPath: string,
  sourceType: ReferenceSourceType,
  referenceBaseDir: string,
): ResolvedReference | undefined {
  if (!ALIAS_RE.test(alias)) {
    return undefined;
  }

  if (typeof value === "string") {
    const resolvedPath = resolveReferencePath(referenceBaseDir, value);
    if (!isExplicitGitReference(value) && existsSync(resolvedPath)) {
      return {
        alias,
        kind: "local",
        declaredPath: value,
        resolvedPath,
        hidden: false,
        sourceConfigPath,
        sourceType,
      };
    }

    if (looksLikeGitReference(value)) {
      return {
        alias,
        kind: "git",
        repository: value,
        hidden: false,
        sourceConfigPath,
        sourceType,
      };
    }

    return {
      alias,
      kind: "local",
      declaredPath: value,
      resolvedPath,
      hidden: false,
      sourceConfigPath,
      sourceType,
    };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeLocal = value as Partial<LocalReferenceConfig>;
  const maybeGit = value as Partial<GitReferenceConfig>;

  if (typeof maybeLocal.path === "string" && maybeGit.repository === undefined) {
    const resolvedPath = resolveReferencePath(referenceBaseDir, maybeLocal.path);
    return {
      alias,
      kind: "local",
      declaredPath: maybeLocal.path,
      resolvedPath,
      hidden: maybeLocal.hidden === true,
      description: typeof maybeLocal.description === "string" ? maybeLocal.description : undefined,
      sourceConfigPath,
      sourceType,
    };
  }

  if (typeof maybeGit.repository === "string" && maybeLocal.path === undefined) {
    return {
      alias,
      kind: "git",
      repository: maybeGit.repository,
      branch: typeof maybeGit.branch === "string" ? maybeGit.branch : undefined,
      hidden: maybeGit.hidden === true,
      description: typeof maybeGit.description === "string" ? maybeGit.description : undefined,
      sourceConfigPath,
      sourceType,
    };
  }

  return undefined;
}

function collectConfigPaths(cwd: string, options: LoadReferencesOptions = {}): ConfigPath[] {
  const paths: ConfigPath[] = [];
  const home = process.env.HOME;

  if (home) {
    const referenceBaseDir = join(home, ".pi", "agent");
    for (const name of GLOBAL_CONFIG_NAMES) {
      const path = join(referenceBaseDir, name);
      if (existsSync(path)) {
        paths.push({ path, sourceType: "global", referenceBaseDir });
      }
    }
  }

  if (options.includeProject !== false) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const path = join(cwd, ".pi", name);
      if (existsSync(path)) {
        paths.push({ path, sourceType: "project", referenceBaseDir: cwd });
      }
    }
  }

  return paths;
}

export function loadReferences(
  cwd: string,
  options: LoadReferencesOptions = {},
): { references: ResolvedReference[]; warnings: string[] } {
  const warnings: string[] = [];
  const merged = new Map<string, ResolvedReference>();

  for (const entry of collectConfigPaths(cwd, options)) {
    try {
      const config = readConfigFile(entry.path);
      const refs = config.references ?? {};
      for (const [alias, value] of Object.entries(refs)) {
        const normalized = normalizeReference(alias, value, entry.path, entry.sourceType, entry.referenceBaseDir);
        if (!normalized) {
          warnings.push(`Invalid reference "${alias}" in ${entry.path}`);
          continue;
        }

        if (normalized.kind === "local" && normalized.resolvedPath && !existsSync(normalized.resolvedPath)) {
          warnings.push(`Reference "${alias}" points to a missing path: ${normalized.resolvedPath}`);
          continue;
        }

        merged.set(alias, normalized);
      }
    } catch (error: any) {
      warnings.push(`Failed to load ${entry.path}: ${error?.message ?? String(error)}`);
    }
  }

  return {
    references: Array.from(merged.values()).sort((a, b) => a.alias.localeCompare(b.alias)),
    warnings,
  };
}
