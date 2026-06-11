import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedReference } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;

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

  if (/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return `https://github.com/${repository}${repository.endsWith(".git") ? "" : ".git"}`;
  }

  return repository;
}

function getCacheRoot(): string {
  return join(homedir(), ".pi", "agent", "cache", "references");
}

async function isGitCheckout(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"));
}

export async function materializeGitReferences(
  pi: ExtensionAPI,
  references: ResolvedReference[],
): Promise<string[]> {
  const warnings: string[] = [];
  const cacheRoot = getCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  for (const reference of references) {
    if (reference.kind !== "git" || !reference.repository) {
      continue;
    }

    const targetDir = join(cacheRoot, `${reference.alias}-${cacheKey(reference)}`);
    reference.resolvedPath = targetDir;

    if (await isGitCheckout(targetDir)) {
      continue;
    }

    if (existsSync(targetDir)) {
      reference.error = `Cache path exists but is not a git checkout: ${targetDir}`;
      warnings.push(`Reference "${reference.alias}" cache path exists but is not a git checkout: ${targetDir}`);
      continue;
    }

    const cloneUrl = normalizeGitUrl(reference.repository);
    const args = ["clone", "--depth", "1"];
    if (reference.branch) {
      args.push("--branch", reference.branch);
    }
    args.push(cloneUrl, targetDir);

    const result = await pi.exec("git", args, { timeout: DEFAULT_TIMEOUT_MS });
    if (result.code !== 0) {
      reference.error = result.stderr.trim() || `git clone exited with ${result.code}`;
      reference.resolvedPath = undefined;
      warnings.push(`Failed to clone reference "${reference.alias}": ${reference.error}`);
    }
  }

  return warnings;
}
