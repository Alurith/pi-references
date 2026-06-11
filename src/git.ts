import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedReference } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const inFlightClones = new Map<string, Promise<string | undefined>>();

function cacheKey(reference: ResolvedReference): string {
  const input = `${reference.repository ?? ""}\n${reference.branch ?? ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeGitUrl(repository: string): string {
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(repository)) {
    return repository;
  }

  if (repository.startsWith("github.com/")) {
    return `https://${repository}${repository.endsWith(".git") ? "" : ".git"}`;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) {
    return `https://github.com/${repository}${repository.endsWith(".git") ? "" : ".git"}`;
  }

  return repository;
}

function getCacheRoot(): string {
  return join(homedir(), ".pi", "agent", "cache", "references");
}

function getTargetDir(reference: ResolvedReference): string | undefined {
  if (reference.kind !== "git" || !reference.repository) {
    return undefined;
  }
  return join(getCacheRoot(), `${reference.alias}-${cacheKey(reference)}`);
}

function isGitCheckout(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export function assignGitCachePaths(references: ResolvedReference[]): void {
  for (const reference of references) {
    const targetDir = getTargetDir(reference);
    if (targetDir) {
      reference.resolvedPath = targetDir;
    }
  }
}

async function cloneReference(pi: ExtensionAPI, reference: ResolvedReference, targetDir: string): Promise<string | undefined> {
  if (!reference.repository) {
    return `Reference "${reference.alias}" is missing repository`;
  }

  const cacheRoot = getCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  if (isGitCheckout(targetDir)) {
    reference.error = undefined;
    reference.resolvedPath = targetDir;
    return undefined;
  }

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }

  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tempDir, { recursive: true, force: true });

  const cloneUrl = normalizeGitUrl(reference.repository);
  const args = ["clone", "--depth", "1"];
  if (reference.branch) {
    args.push("--branch", reference.branch);
  }
  args.push(cloneUrl, tempDir);

  const result = await pi.exec("git", args, { timeout: DEFAULT_TIMEOUT_MS });
  if (result.code !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    reference.error = result.stderr.trim() || `git clone exited with ${result.code}`;
    return `Failed to clone reference "${reference.alias}": ${reference.error}`;
  }

  try {
    await rename(tempDir, targetDir);
  } catch (error: any) {
    await rm(tempDir, { recursive: true, force: true });
    reference.error = error?.message ?? String(error);
    return `Failed to finalize reference "${reference.alias}": ${reference.error}`;
  }

  reference.error = undefined;
  reference.resolvedPath = targetDir;
  return undefined;
}

export async function materializeGitReference(
  pi: ExtensionAPI,
  reference: ResolvedReference,
): Promise<string | undefined> {
  const targetDir = getTargetDir(reference);
  if (!targetDir) {
    return undefined;
  }

  reference.resolvedPath = targetDir;

  if (isGitCheckout(targetDir)) {
    reference.error = undefined;
    return undefined;
  }

  const existing = inFlightClones.get(targetDir);
  if (existing) {
    return existing;
  }

  const promise = cloneReference(pi, reference, targetDir).finally(() => {
    inFlightClones.delete(targetDir);
  });
  inFlightClones.set(targetDir, promise);
  return promise;
}
