import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveReferencePath } from "./resolve";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedReference } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_SYNCS = 4;

type GitOperationResult = {
  action: GitSyncAction;
  warning?: string;
};

export type GitSyncOptions = {
  signal?: AbortSignal;
};

export type GitSyncAction = "cloned" | "refreshed" | "unchanged" | "failed";

export type GitSyncResult = {
  alias: string;
  action: GitSyncAction;
  warning?: string;
};

type InFlightOperation = {
  promise: Promise<GitOperationResult>;
  signal?: AbortSignal;
};

const inFlightOperations = new Map<string, InFlightOperation>();

function cacheKey(reference: ResolvedReference): string {
  const input = `${reference.repository ?? ""}\n${reference.branch ?? ""}\n${reference.referenceBaseDir ?? ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeGitUrl(repository: string, baseDir = process.cwd()): string {
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(repository)) {
    return repository;
  }

  if (repository.startsWith("github.com/")) {
    return `https://${repository}${repository.endsWith(".git") ? "" : ".git"}`;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) {
    return `https://github.com/${repository}${repository.endsWith(".git") ? "" : ".git"}`;
  }

  if (isAbsolute(repository) || repository.startsWith("./") || repository.startsWith("../") || repository.startsWith("~/") || repository === "." || repository === "..") {
    return resolveReferencePath(baseDir, repository);
  }

  return repository;
}

function getCacheRoot(): string {
  return join(getAgentDir(), "cache", "references");
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

function comparableRepository(repository: string, baseDir?: string): string {
  let normalized = normalizeGitUrl(repository, baseDir);
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(normalized)) {
    try {
      normalized = realpathSync.native(normalized);
    } catch {
      // Keep the resolved lexical path when the local repository disappeared.
    }
  }
  normalized = normalized.replace(/\/+$/, "").replace(/\.git$/i, "");
  return normalized.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, (scheme) => scheme.toLowerCase());
}

async function hasMatchingCheckout(
  pi: ExtensionAPI,
  reference: ResolvedReference,
  targetDir: string,
  options: GitSyncOptions,
): Promise<boolean> {
  if (!isGitCheckout(targetDir)) {
    return false;
  }

  try {
    const result = await pi.exec("git", ["-C", targetDir, "config", "--get", "remote.origin.url"], {
      timeout: DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
    if (result.code !== 0 || !result.stdout.trim() || !reference.repository) {
      return false;
    }
    return comparableRepository(result.stdout.trim()) === comparableRepository(reference.repository, reference.referenceBaseDir);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function failedResult(message: string): GitOperationResult {
  return {
    action: "failed",
    warning: message,
  };
}

function applyOperationResult(
  reference: ResolvedReference,
  targetDir: string,
  result: GitOperationResult,
): void {
  reference.cachePath = targetDir;
  reference.error = result.warning;

  // A failed clone must not be exposed as a usable filesystem path. An
  // existing checkout remains usable when only its refresh failed.
  if (result.action === "failed") {
    if (!isGitCheckout(targetDir)) {
      reference.resolvedPath = undefined;
    }
    return;
  }

  reference.resolvedPath = targetDir;
}

function runExclusiveGitOperation(
  targetDir: string,
  operation: () => Promise<GitOperationResult>,
  signal?: AbortSignal,
): Promise<GitOperationResult> {
  const existing = inFlightOperations.get(targetDir);
  if (existing && !existing.signal?.aborted) {
    return existing.promise;
  }
  if (existing) {
    inFlightOperations.delete(targetDir);
  }

  const promise = operation()
    .catch((error: unknown) => failedResult(errorMessage(error)))
    .finally(() => {
      if (inFlightOperations.get(targetDir)?.promise === promise) {
        inFlightOperations.delete(targetDir);
      }
    });

  inFlightOperations.set(targetDir, { promise, signal });
  return promise;
}

export function assignGitCachePaths(references: ResolvedReference[]): void {
  for (const reference of references) {
    const targetDir = getTargetDir(reference);
    if (targetDir) {
      reference.cachePath = targetDir;
      // Do not mark the cache path as resolved until its origin has been
      // verified or it has been materialized successfully.
      reference.resolvedPath = undefined;
    }
  }
}

async function cloneReference(
  pi: ExtensionAPI,
  reference: ResolvedReference,
  targetDir: string,
  options: GitSyncOptions,
): Promise<GitOperationResult> {
  if (!reference.repository) {
    return failedResult(`Reference "${reference.alias}" is missing repository`);
  }

  const cacheRoot = getCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }

  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tempDir, { recursive: true, force: true });

  const cloneUrl = normalizeGitUrl(reference.repository, reference.referenceBaseDir);
  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
  if (reference.branch) {
    args.push("--branch", reference.branch);
  }
  args.push("--", cloneUrl, tempDir);

  let result;
  try {
    result = await pi.exec("git", args, {
      timeout: DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error: unknown) {
    await rm(tempDir, { recursive: true, force: true });
    return failedResult(`git clone failed: ${errorMessage(error)}`);
  }

  if (result.code !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    return failedResult(result.stderr.trim() || `git clone exited with ${result.code}`);
  }

  try {
    await rename(tempDir, targetDir);
  } catch (error: unknown) {
    await rm(tempDir, { recursive: true, force: true });
    return failedResult(errorMessage(error));
  }

  return { action: "cloned" };
}

async function refreshReference(
  pi: ExtensionAPI,
  reference: ResolvedReference,
  targetDir: string,
  options: GitSyncOptions,
): Promise<GitOperationResult> {
  if (!reference.repository) {
    return failedResult(`Reference "${reference.alias}" is missing repository`);
  }

  let statusResult;
  try {
    statusResult = await pi.exec(
      "git",
      ["-C", targetDir, "status", "--porcelain", "--untracked-files=all"],
      {
        timeout: DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      },
    );
  } catch (error: unknown) {
    return failedResult(`git status failed: ${errorMessage(error)}`);
  }

  if (statusResult.code !== 0) {
    return failedResult(statusResult.stderr.trim() || `git status exited with ${statusResult.code}`);
  }

  if (statusResult.stdout.trim()) {
    return failedResult(`checkout "${reference.alias}" has local changes; refresh skipped`);
  }

  const fetchArgs = [
    "-C",
    targetDir,
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    "origin",
  ];
  if (reference.branch) {
    fetchArgs.push(reference.branch);
  }

  let fetchResult;
  try {
    fetchResult = await pi.exec("git", fetchArgs, {
      timeout: DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error: unknown) {
    return failedResult(`git fetch failed: ${errorMessage(error)}`);
  }

  if (fetchResult.code !== 0) {
    return failedResult(fetchResult.stderr.trim() || `git fetch exited with ${fetchResult.code}`);
  }

  let resetResult;
  try {
    resetResult = await pi.exec(
      "git",
      ["-C", targetDir, "reset", "--hard", "FETCH_HEAD"],
      {
        timeout: DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      },
    );
  } catch (error: unknown) {
    return failedResult(`git reset failed: ${errorMessage(error)}`);
  }

  if (resetResult.code !== 0) {
    return failedResult(resetResult.stderr.trim() || `git reset exited with ${resetResult.code}`);
  }

  return { action: "refreshed" };
}

export async function materializeGitReference(
  pi: ExtensionAPI,
  reference: ResolvedReference,
  options: GitSyncOptions = {},
): Promise<string | undefined> {
  const targetDir = getTargetDir(reference);
  if (!targetDir) {
    return undefined;
  }

  const result = await runExclusiveGitOperation(targetDir, async () => {
    if (await hasMatchingCheckout(pi, reference, targetDir, options)) {
      return { action: "unchanged" };
    }

    return cloneReference(pi, reference, targetDir, options);
  }, options.signal);

  applyOperationResult(reference, targetDir, result);
  return result.warning;
}

export async function synchronizeGitReference(
  pi: ExtensionAPI,
  reference: ResolvedReference,
  options: GitSyncOptions = {},
): Promise<GitSyncResult> {
  const targetDir = getTargetDir(reference);
  if (!targetDir) {
    const warning = `Reference "${reference.alias}" is missing repository`;
    reference.error = warning;
    return { alias: reference.alias, action: "failed", warning };
  }

  const result = await runExclusiveGitOperation(targetDir, async () => {
    if (await hasMatchingCheckout(pi, reference, targetDir, options)) {
      return refreshReference(pi, reference, targetDir, options);
    }

    return cloneReference(pi, reference, targetDir, options);
  }, options.signal);

  applyOperationResult(reference, targetDir, result);
  return {
    alias: reference.alias,
    action: result.action,
    warning: result.warning,
  };
}

export async function synchronizeAllGitReferences(
  pi: ExtensionAPI,
  references: ResolvedReference[],
  options: GitSyncOptions = {},
): Promise<GitSyncResult[]> {
  const gitReferences = references.filter((reference) => reference.kind === "git");
  const results: PromiseSettledResult<GitSyncResult>[] = [];
  for (let offset = 0; offset < gitReferences.length; offset += MAX_CONCURRENT_SYNCS) {
    const batch = gitReferences.slice(offset, offset + MAX_CONCURRENT_SYNCS);
    results.push(...await Promise.allSettled(
      batch.map((reference) => synchronizeGitReference(pi, reference, options)),
    ));
  }

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    const reference = gitReferences[index];
    const warning = errorMessage(result.reason);
    reference.error = warning;
    return {
      alias: reference.alias,
      action: "failed",
      warning,
    };
  });
}
