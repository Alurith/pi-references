import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify } from "jsonc-parser";
import {
  classifyReferenceSource,
  isValidReferenceAlias,
  parseReferencesConfigText,
} from "./config.ts";
import { resolveReferencePath } from "./resolve.ts";
import { withFileLock } from "./file-lock.ts";
import type { ReferenceConfigValue } from "./types.ts";

export type ReferenceScope = "project" | "global";

export type AddReferenceRequest = {
  alias: string;
  source: string;
  branch?: string;
  scope: ReferenceScope;
};

type ConfigTarget = {
  path: string;
  baseDir: string;
  exists: boolean;
};

export function getWritableConfigPath(cwd: string, scope: ReferenceScope): ConfigTarget {
  const baseDir = scope === "global" ? getAgentDir() : cwd;
  const configDir = scope === "global" ? baseDir : join(cwd, CONFIG_DIR_NAME);
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

async function writeFileAtomically(path: string, content: string, signal: AbortSignal): Promise<void> {
  const tempDir = await mkdtemp(join(dirname(path), ".references-write-"));
  const tempPath = join(tempDir, "config");
  try {
    await writeFile(tempPath, content, "utf8");
    signal.throwIfAborted();
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function addReferenceToConfig(
  cwd: string,
  request: AddReferenceRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (!isValidReferenceAlias(request.alias)) {
    throw new Error(`Invalid reference alias "${request.alias}"`);
  }

  signal?.throwIfAborted();
  const source = request.source.trim();
  if (!source) {
    throw new Error("Reference path or repository cannot be empty");
  }
  const configDir = request.scope === "global" ? getAgentDir() : join(cwd, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const resource = join(await realpath(configDir), "references");
  return withFileLock(resource, async (activeSignal) => {
    const target = getWritableConfigPath(cwd, request.scope);
    const classified = classifyReferenceSource(source, target.baseDir, request.branch?.trim());
    if (!classified) throw new Error("Invalid repository or branch");

    if (classified.kind === "local") {
      const resolvedPath = resolveReferencePath(target.baseDir, classified.value.path);
      try {
        if (!statSync(resolvedPath).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(`Local reference path does not exist or is not a directory: ${resolvedPath}`);
      }
    }

    const rawConfig = target.exists ? await readFile(target.path, "utf8") : "{}\n";
    const references = parseReferencesConfigText(rawConfig).references ?? {};
    if (Object.hasOwn(references, request.alias)) {
      throw new Error(`Reference alias "${request.alias}" already exists`);
    }

    const nextConfig = updateConfig(rawConfig, request.alias, classified.value);
    await writeFileAtomically(target.path, nextConfig, activeSignal);
    return target.path;
  }, signal);
}
