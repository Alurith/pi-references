import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { loadReferences, parseReferencesConfigText, isValidReferenceAlias } from "../src/config";
import { materializeGitReference } from "../src/git";
import { resolveInsideRoot } from "../src/resolve";
import { expandReferencesInText } from "../src/transform";
import { findReferenceTokens, parseReferenceQueryAtCursor } from "../src/tokenize";
import type { ResolvedReference } from "../src/types";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
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

describe("extension integration", () => {
  it("adds references as a replaceable system-prompt section", async () => {
    const root = await temporaryDirectory();
    const referenceRoot = await temporaryDirectory();
    await mkdir(join(root, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(root, CONFIG_DIR_NAME, "references.json"),
      JSON.stringify({
        references: {
          docs: { path: referenceRoot, description: "Product docs" },
          sdk: { repository: "owner/sdk", description: "SDK source" },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");

    type Handler = (event: any, ctx: any) => unknown;
    const handlers = new Map<string, Handler>();
    const statuses: Array<[string, string | undefined]> = [];
    let commandOptions: {
      getArgumentCompletions?: (prefix: string) => unknown;
      handler?: (args: string, ctx: any) => Promise<void>;
    } | undefined;
    const pi = {
      registerCommand(_name: string, options: typeof commandOptions) {
        commandOptions = options;
      },
      exec: async () => ({ code: 128, stdout: "", stderr: "clone failed" }),
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
        return () => {};
      },
    } as unknown as ExtensionAPI;
    extension(pi);

    assert.ok(commandOptions?.getArgumentCompletions);
    assert.deepEqual(commandOptions.getArgumentCompletions(""), [
      { value: "add", label: "add" },
      { value: "sync", label: "sync" },
    ]);
    assert.deepEqual(commandOptions.getArgumentCompletions("add "), [
      { value: "--global", label: "--global" },
    ]);

    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart);
    sessionStart(
      { type: "session_start", reason: "startup" },
      {
        cwd: root,
        isProjectTrusted: () => true,
        ui: {
          addAutocompleteProvider() {},
          notify() {},
          setStatus(key: string, text: string | undefined) {
            statuses.push([key, text]);
          },
        },
      },
    );

    assert.ok(commandOptions?.handler);
    await commandOptions.handler("sync sdk", {
      signal: undefined,
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
        notify() {},
      },
    });
    assert.deepEqual(statuses, [
      ["pi-references", "Syncing sdk…"],
      ["pi-references", undefined],
    ]);

    const beforeAgentStart = handlers.get("before_agent_start");
    assert.ok(beforeAgentStart);
    const event: { systemPrompt: string; systemPromptOptions: { sections: Record<string, string> } } = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {} },
    };
    assert.equal(beforeAgentStart(event, {}), undefined);
    assert.match(event.systemPromptOptions.sections["pi-references"], /Available references:/);
    assert.match(event.systemPromptOptions.sections["pi-references"], /Product docs/);
    assert.deepEqual(commandOptions.getArgumentCompletions("sync s"), [
      { value: "sdk", label: "sdk", description: "SDK source" },
    ]);

    const legacyEvent = { systemPrompt: "base", systemPromptOptions: {} } as any;
    const legacyResult = beforeAgentStart(legacyEvent, {}) as { systemPrompt?: string } | undefined;
    assert.match(legacyResult?.systemPrompt ?? "", /^base\nAvailable references:/);

    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionShutdown);
    await sessionShutdown({}, {});
  });

  it("waits for previous session synchronizations before shutdown", async () => {
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    const agentRoot = await temporaryDirectory();
    await mkdir(join(firstRoot, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(join(secondRoot, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(firstRoot, CONFIG_DIR_NAME, "references.json"),
      JSON.stringify({ references: { first: "owner/first" } }),
    );
    await writeFile(
      join(secondRoot, CONFIG_DIR_NAME, "references.json"),
      JSON.stringify({ references: { second: "owner/second" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentRoot;

    type Handler = (event: any, ctx: any) => unknown;
    const handlers = new Map<string, Handler>();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const pi = {
      registerCommand() {},
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
        return () => {};
      },
      exec: async (_command: string, args: string[]) => {
        const repository = args.at(-2) ?? "";
        if (repository.includes("/first.git")) {
          markFirstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { code: 128, stdout: "", stderr: "first failed" };
        }
        if (repository.includes("/second.git")) {
          markSecondStarted();
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
          return { code: 128, stdout: "", stderr: "second failed" };
        }
        return { code: 1, stdout: "", stderr: "unknown repository" };
      },
    } as unknown as ExtensionAPI;
    extension(pi);

    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionStart);
    assert.ok(sessionShutdown);
    const sessionContext = (cwd: string) => ({
      cwd,
      isProjectTrusted: () => true,
      ui: { addAutocompleteProvider() {}, notify() {} },
    });

    sessionStart({ type: "session_start", reason: "startup" }, sessionContext(firstRoot));
    await firstStarted;
    sessionStart({ type: "session_start", reason: "new" }, sessionContext(secondRoot));
    await secondStarted;

    let shutdownFinished = false;
    const shutdownPromise = sessionShutdown({}, {}) as Promise<void>;
    shutdownPromise.then(() => {
      shutdownFinished = true;
    });
    releaseSecond();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownFinished, false);

    releaseFirst();
    await shutdownPromise;
    assert.equal(shutdownFinished, true);
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

    assert.equal(findReferenceTokens("(<@docs/src>")[0]?.alias, "docs");
    assert.equal(findReferenceTokens("`@docs/src`")[0]?.rawPath, "/src");
    assert.deepEqual(parseReferenceQueryAtCursor("look at ，@docs/src/"), {
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
  });

  it("retries a shared Git operation after the first caller is aborted", async () => {
    const root = await temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = root;
    let releaseFirstClone!: () => void;
    let markFirstCloneStarted!: () => void;
    const firstCloneStarted = new Promise<void>((resolve) => {
      markFirstCloneStarted = resolve;
    });
    let cloneCount = 0;
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] !== "clone") {
          return { code: 1, stdout: "", stderr: "" };
        }
        cloneCount++;
        if (cloneCount === 1) {
          markFirstCloneStarted();
          await new Promise<void>((resolve) => {
            releaseFirstClone = resolve;
          });
          return { code: 128, stdout: "", stderr: "clone failed" };
        }
        const tempDir = args.at(-1);
        assert.ok(tempDir);
        await mkdir(join(tempDir, ".git"), { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      },
    } as never;
    const first: ResolvedReference = {
      alias: "shared",
      kind: "git",
      repository: "owner/missing",
      hidden: false,
    };
    const second = { ...first };
    const controller = new AbortController();

    const firstOperation = materializeGitReference(pi, first, { signal: controller.signal });
    await firstCloneStarted;
    controller.abort();
    const secondOperation = materializeGitReference(pi, second);

    assert.equal(calls.filter((args) => args[0] === "clone").length, 1);
    releaseFirstClone();
    const [firstWarning, secondWarning] = await Promise.all([firstOperation, secondOperation]);
    assert.equal(firstWarning, "clone failed");
    assert.equal(secondWarning, undefined);
    assert.equal(cloneCount, 2);
    assert.ok(second.resolvedPath);
  });
});
