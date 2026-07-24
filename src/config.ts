import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, type ParseError } from "jsonc-parser";
import type {
  GitReferenceConfig,
  LocalReferenceConfig,
  ReferencesConfigFile,
  ReferenceSourceType,
  ResolvedReference,
} from "./types";
import { resolveReferencePath } from "./resolve";

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^[^\s\0-][^\s\0]*$/;
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

function looksLikeLocalPath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/") || value.startsWith("/") || value.startsWith("\\\\");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isValidReferenceAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

export function classifyReferenceSource(
  source: string,
  referenceBaseDir: string,
  branch?: string,
):
  | { kind: "local"; value: LocalReferenceConfig }
  | { kind: "git"; value: GitReferenceConfig }
  | undefined {
  if (branch !== undefined) {
    if (!BRANCH_RE.test(branch) || looksLikeLocalPath(source) || !looksLikeGitReference(source)) {
      return undefined;
    }

    return {
      kind: "git",
      value: {
        repository: source,
        branch,
      },
    };
  }

  const resolvedPath = resolveReferencePath(referenceBaseDir, source);
  if (looksLikeLocalPath(source) || (!isExplicitGitReference(source) && isDirectory(resolvedPath))) {
    return {
      kind: "local",
      value: { path: source },
    };
  }

  if (looksLikeGitReference(source)) {
    return {
      kind: "git",
      value: { repository: source },
    };
  }

  return {
    kind: "local",
    value: { path: source },
  };
}

export function parseReferencesConfigText(input: string): ReferencesConfigFile {
  const errors: ParseError[] = [];
  const parsed = parse(input, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid JSONC at offset ${errors[0]?.offset ?? 0}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Configuration must contain a valid JSON object");
  }
  if (parsed.references !== undefined &&
      (!parsed.references || typeof parsed.references !== "object" || Array.isArray(parsed.references))) {
    throw new Error('The "references" property must be an object');
  }
  return parsed as ReferencesConfigFile;
}

function readConfigFile(path: string): ReferencesConfigFile {
  return parseReferencesConfigText(readFileSync(path, "utf8"));
}

function normalizeReference(
  alias: string,
  value: unknown,
  sourceConfigPath: string,
  sourceType: ReferenceSourceType,
  referenceBaseDir: string,
): ResolvedReference | undefined {
  if (!isValidReferenceAlias(alias)) {
    return undefined;
  }

  if (typeof value === "string") {
    if (!value.trim()) {
      return undefined;
    }

    const resolvedPath = resolveReferencePath(referenceBaseDir, value);
    if (looksLikeLocalPath(value) || (!isExplicitGitReference(value) && isDirectory(resolvedPath))) {
      return {
        alias,
        kind: "local",
        declaredPath: value,
        resolvedPath,
        hidden: false,
        sourceConfigPath,
        sourceType,
        referenceBaseDir,
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
        referenceBaseDir,
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
      referenceBaseDir,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const maybeLocal = value as Partial<LocalReferenceConfig>;
  const maybeGit = value as Partial<GitReferenceConfig>;

  if (typeof maybeLocal.path === "string" && maybeLocal.path.trim() && maybeGit.repository === undefined) {
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
      referenceBaseDir,
    };
  }

  if (typeof maybeGit.repository === "string" && maybeGit.repository.trim() && maybeLocal.path === undefined) {
    if (maybeGit.branch !== undefined && (typeof maybeGit.branch !== "string" || !BRANCH_RE.test(maybeGit.branch))) {
      return undefined;
    }
    return {
      alias,
      kind: "git",
      repository: maybeGit.repository,
      branch: typeof maybeGit.branch === "string" ? maybeGit.branch : undefined,
      hidden: maybeGit.hidden === true,
      description: typeof maybeGit.description === "string" ? maybeGit.description : undefined,
      sourceConfigPath,
      sourceType,
      referenceBaseDir,
    };
  }

  return undefined;
}

function collectConfigPaths(cwd: string, options: LoadReferencesOptions = {}): ConfigPath[] {
  const paths: ConfigPath[] = [];
  const referenceBaseDir = getAgentDir();

  {
    const globalBaseDir = referenceBaseDir;
    for (const name of GLOBAL_CONFIG_NAMES) {
      const path = join(globalBaseDir, name);
      if (existsSync(path)) {
        paths.push({ path, sourceType: "global", referenceBaseDir: globalBaseDir });
      }
    }
  }

  if (options.includeProject !== false) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const path = join(cwd, CONFIG_DIR_NAME, name);
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
        // A project declaration shadows the global alias even when invalid or
        // pointing to a missing path. Falling back to a global value is unsafe
        // and contradicts the documented precedence rules.
        if (entry.sourceType === "project") {
          merged.delete(alias);
        }

        const normalized = normalizeReference(alias, value, entry.path, entry.sourceType, entry.referenceBaseDir);
        if (!normalized) {
          warnings.push(`Invalid reference "${alias}" in ${entry.path}`);
          continue;
        }

        if (normalized.kind === "local" && normalized.resolvedPath && !isDirectory(normalized.resolvedPath)) {
          warnings.push(`Reference "${alias}" points to a missing or non-directory path: ${normalized.resolvedPath}`);
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
