import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

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

export function resolveInsideRoot(root: string, rawSubpath: string | undefined): string | undefined {
  const resolvedRoot = resolve(root);
  const subpath = rawSubpath ?? "";

  if (subpath.includes("\0") || isAbsolute(subpath)) {
    return undefined;
  }

  const target = resolve(resolvedRoot, subpath);
  const relativePath = relative(resolvedRoot, target);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return target;
  }

  return undefined;
}
