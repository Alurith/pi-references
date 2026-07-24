import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import {
  classifyReferenceSource,
  isValidReferenceAlias,
} from "./config";
import type { ReferenceConfigValue } from "./types";

export type ReferenceScope = "project" | "global";

export type AddReferenceRequest = {
  alias: string;
  source: string;
  branch?: string;
  scope: ReferenceScope;
};

export type AddReferenceResult = {
  configPath: string;
  createdConfig: boolean;
};

type ConfigTarget = {
  path: string;
  baseDir: string;
  exists: boolean;
};

function getGlobalBaseDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function getWritableConfigPath(cwd: string, scope: ReferenceScope): ConfigTarget {
  const baseDir = scope === "global" ? getGlobalBaseDir() : cwd;
  const configDir = scope === "global" ? baseDir : join(cwd, ".pi");
  const jsoncPath = join(configDir, "references.jsonc");
  const jsonPath = join(configDir, "references.json");

  if (existsSync(jsoncPath)) {
    return { path: jsoncPath, baseDir, exists: true };
  }

  if (existsSync(jsonPath)) {
    return { path: jsonPath, baseDir, exists: true };
  }

  return { path: jsoncPath, baseDir, exists: false };
}

function parseConfig(rawConfig: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(rawConfig, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Configuration must contain a valid JSON object");
  }
  return parsed as Record<string, unknown>;
}

function updateConfig(
  rawConfig: string,
  alias: string,
  value: ReferenceConfigValue,
): string {
  const eol = rawConfig.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(rawConfig, ["references", alias], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol,
    },
  });

  return applyEdits(rawConfig, edits);
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function addReferenceToConfig(
  cwd: string,
  request: AddReferenceRequest,
): Promise<AddReferenceResult> {
  if (!isValidReferenceAlias(request.alias)) {
    throw new Error(`Invalid reference alias "${request.alias}"`);
  }

  const target = getWritableConfigPath(cwd, request.scope);
  const classified = classifyReferenceSource(request.source, target.baseDir, request.branch);
  if (!classified) {
    throw new Error("Invalid repository or branch");
  }

  const value = classified.value;
  const rawConfig = target.exists ? await readFile(target.path, "utf8") : "{}\n";
  const parsed = parseConfig(rawConfig);
  const references = parsed.references;

  if (references !== undefined) {
    if (!references || typeof references !== "object" || Array.isArray(references)) {
      throw new Error('The "references" property must be an object');
    }

    if (Object.prototype.hasOwnProperty.call(references, request.alias)) {
      throw new Error(`Reference alias "${request.alias}" already exists`);
    }
  }

  const nextConfig = updateConfig(rawConfig, request.alias, value);
  await writeFileAtomically(target.path, nextConfig);

  return {
    configPath: target.path,
    createdConfig: !target.exists,
  };
}
