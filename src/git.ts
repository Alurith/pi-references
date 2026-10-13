import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveReferencePath } from "./resolve.ts";
import { withFileLock } from "./file-lock.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedReference } from "./types.ts";

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

  const origin = await execGit(pi, ["-C", targetDir, "config", "--get", "remote.origin.url"], options);
  return Boolean(origin.trim() && reference.repository &&
    comparableRepository(origin.trim()) === comparableRepository(reference.repository, reference.referenceBaseDir));
}

async function execGit(pi: ExtensionAPI, args: string[], options: GitSyncOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const result = await pi.exec("git", args, { timeout: DEFAULT_TIMEOUT_MS, signal: options.signal });
  options.signal?.throwIfAborted();
  if (result.killed) throw new Error("Git command cancelled or timed out");
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git exited with ${result.code}`);
  return result.stdout;
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

async function runLockedGitOperation(
  targetDir: string,
  operation: (signal: AbortSignal) => Promise<GitOperationResult>,
  signal?: AbortSignal,
): Promise<GitOperationResult> {
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(targetDir), { recursive: true });
    const resource = join(await realpath(dirname(targetDir)), basename(targetDir));
    return await withFileLock(resource, operation, signal);
  } catch (error) {
    return failedResult(errorMessage(error));
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

  options.signal?.throwIfAborted();
  if (existsSync(targetDir)) {
    return failedResult(`Checkout "${reference.alias}" cannot be reused; existing files preserved. Check its origin and save local work before repairing it.`);
  }

  const tempDir = await mkdtemp(`${targetDir}.tmp-`);

  const cloneUrl = normalizeGitUrl(reference.repository, reference.referenceBaseDir);
  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
  if (reference.branch) {
    args.push("--branch", reference.branch);
  }
  args.push("--", cloneUrl, tempDir);

  try {
    await execGit(pi, args, options);
    options.signal?.throwIfAborted();
    await rename(tempDir, targetDir);
    return { action: "cloned" };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

  const status = await execGit(pi, ["-C", targetDir, "status", "--porcelain", "--untracked-files=all"], options);
  if (status.trim()) {
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

  await execGit(pi, fetchArgs, options);
  await execGit(pi, ["-C", targetDir, "checkout", "--detach", "--no-overwrite-ignore", "FETCH_HEAD"], options);

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

  const result = await runLockedGitOperation(targetDir, async (signal) => {
    const lockedOptions = { signal };
    if (await hasMatchingCheckout(pi, reference, targetDir, lockedOptions)) {
      return { action: "unchanged" };
    }

    return cloneReference(pi, reference, targetDir, lockedOptions);
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
    return { alias: reference.alias, action: "failed", warning };
  }

  const result = await runLockedGitOperation(targetDir, async (signal) => {
    const lockedOptions = { signal };
    if (await hasMatchingCheckout(pi, reference, targetDir, lockedOptions)) {
      return refreshReference(pi, reference, targetDir, lockedOptions);
    }

    return cloneReference(pi, reference, targetDir, lockedOptions);
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
    if (options.signal?.aborted) {
      results.push(...batch.map((reference) => ({ status: "fulfilled" as const, value: { alias: reference.alias, action: "failed" as const, warning: "Git synchronization cancelled" } })));
      continue;
    }
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
    return {
      alias: reference.alias,
      action: "failed",
      warning,
    };
  });
}
