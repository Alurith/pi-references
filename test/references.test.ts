import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadReferences, parseReferencesConfigText, isValidReferenceAlias } from "../src/config";
import { materializeGitReference } from "../src/git";
import { resolveInsideRoot } from "../src/resolve";
import { expandReferencesInText } from "../src/transform";
import { findReferenceTokens, parseReferenceQueryAtCursor } from "../src/tokenize";
import type { ResolvedReference } from "../src/types";

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-references-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("reference configuration", () => {
  it("rejects malformed roots and supports JSONC", () => {
    assert.throws(() => parseReferencesConfigText("[]"), /valid JSON object/);
    const parsed = parseReferencesConfigText(`{
      // comment
      "references": { "docs": "./docs", },
    }`);
    assert.deepEqual(parsed.references, { docs: "./docs" });
  });

  it("lets an invalid project alias shadow the global alias", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await mkdir(join(agentDir), { recursive: true });
    await mkdir(join(project, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(join(agentDir, "references.json"), JSON.stringify({ references: { docs: "../global-docs" } }));
    await writeFile(join(project, CONFIG_DIR_NAME, "references.json"), JSON.stringify({ references: { docs: "./missing" } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const loaded = loadReferences(project);
    assert.equal(loaded.references.some((reference) => reference.alias === "docs"), false);
    assert.match(loaded.warnings.join("\n"), /docs/);
  });

  it("accepts only aliases that tokenizer can represent", () => {
    assert.equal(isValidReferenceAlias("docs"), true);
    assert.equal(isValidReferenceAlias("docs.v2-1"), true);
    assert.equal(isValidReferenceAlias(".."), false);
    assert.equal(isValidReferenceAlias("docs!"), false);
    assert.equal(isValidReferenceAlias("../escape"), false);
  });
});

describe("reference tokenization and path safety", () => {
  it("keeps dots in aliases and handles path punctuation", () => {
    const aliasToken = findReferenceTokens("@docs.v2.")[0];
    assert.equal(aliasToken?.alias, "docs.v2.");
    assert.equal(aliasToken?.token, "@docs.v2.");

    const pathToken = findReferenceTokens("@docs/file.ts,")[0];
    assert.equal(pathToken?.alias, "docs");
    assert.equal(pathToken?.rawPath, "/file.ts");
    assert.equal(pathToken?.trailing, ",");

    assert.deepEqual(parseReferenceQueryAtCursor("look at @docs/src/"), {
      aliasQuery: "docs",
      pathQuery: "src/",
      prefix: "@docs/src/",
    });
  });

  it("rejects lexical traversal and symlink escapes", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(root, "external"));

    assert.equal(resolveInsideRoot(root, "../outside"), undefined);
    assert.equal(resolveInsideRoot(root, "external/secret.txt"), undefined);
    assert.equal(resolveInsideRoot(root, "missing/file.txt"), join(root, "missing", "file.txt"));
  });
});

describe("Git materialization", () => {
  it("does not expose a path after a failed clone", async () => {
    const root = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = root;
    const reference: ResolvedReference = {
      alias: "broken",
      kind: "git" as const,
      repository: "owner/missing",
      hidden: false,
      sourceConfigPath: "test",
      sourceType: "project" as const,
    };
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        return { code: 128, stdout: "", stderr: "clone failed" };
      },
    } as never;

    const warning = await materializeGitReference(pi, reference);
    assert.equal(warning, "clone failed");
    assert.equal(reference.resolvedPath, undefined);
    assert.equal(expandReferencesInText("@broken/src/index.ts", [reference]), "@broken/src/index.ts");
    assert.equal(calls[0]?.includes("--"), true);
    assert.equal(reference.cachePath ? existsSync(reference.cachePath) : false, false);
  });

  it("keeps an aborted Git operation exclusive until it settles", async () => {
    const root = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = root;
    let releaseClone!: () => void;
    let markCloneStarted!: () => void;
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] !== "clone") {
          return { code: 1, stdout: "", stderr: "" };
        }
        markCloneStarted();
        await new Promise<void>((resolve) => {
          releaseClone = resolve;
        });
        return { code: 128, stdout: "", stderr: "clone failed" };
      },
    } as never;
    const first: ResolvedReference = {
      alias: "shared",
      kind: "git",
      repository: "owner/missing",
      hidden: false,
      sourceConfigPath: "test",
      sourceType: "project",
    };
    const second = { ...first };
    const controller = new AbortController();

    const firstOperation = materializeGitReference(pi, first, { signal: controller.signal });
    await cloneStarted;
    controller.abort();
    const secondOperation = materializeGitReference(pi, second);

    assert.equal(calls.filter((args) => args[0] === "clone").length, 1);
    releaseClone();
    await Promise.all([firstOperation, secondOperation]);
  });
});
