import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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
