import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return resolve(homedir(), input.slice(2));
  }
  return input;
}

export function resolveReferencePath(baseDir: string, declaredPath: string): string {
  const expanded = expandHome(declaredPath);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(baseDir, expanded);
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

/**
 * Resolve a path below a root while checking both lexical traversal and the
 * real filesystem boundary. The nearest existing ancestor is checked when the
 * requested target does not exist yet.
 */
export function resolveInsideRoot(root: string, rawSubpath: string | undefined): string | undefined {
  const resolvedRoot = resolve(root);
  const subpath = rawSubpath ?? "";

  if (subpath.includes("\0") || isAbsolute(subpath)) {
    return undefined;
  }

  const target = resolve(resolvedRoot, subpath);
  if (!isInside(resolvedRoot, target) || !existsSync(resolvedRoot)) {
    return undefined;
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolvedRoot);
  } catch {
    return undefined;
  }

  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      return undefined;
    }
    existing = parent;
  }

  try {
    return isInside(canonicalRoot, realpathSync.native(existing)) ? target : undefined;
  } catch {
    return undefined;
  }
}
