import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { materializeGitReference, synchronizeGitReference, synchronizeAllGitReferences } from "../src/git.ts";
import type { ResolvedReference } from "../src/types.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "references-git-"));
  roots.push(root);
  const origin = join(root, "origin");
  const emptyConfig = join(root, "gitconfig");
  await writeFile(emptyConfig, "");
  await mkdir(origin);
  await mkdir(join(root, "hooks"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: "0" };
  const execute = (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    if (options?.signal?.aborted) return Promise.resolve({ code: 0, killed: true, stdout: "", stderr: "" });
    return new Promise((resolve) => {
      execFile(command, args, { cwd: root, env, signal: options?.signal, timeout: options?.timeout }, (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 128 : 0;
        resolve({ code, killed: Boolean(options?.signal?.aborted || error?.killed), stdout, stderr });
      });
    });
  };
  const pi = { exec: execute } as ExtensionAPI;
  const git = async (...args: string[]) => {
    const result = await execute("git", args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git("init", "--initial-branch=main", origin);
  await git("-C", origin, "config", "user.name", "Test");
  await git("-C", origin, "config", "user.email", "test@example.invalid");
  await git("-C", origin, "config", "commit.gpgsign", "false");
  await git("-C", origin, "config", "core.hooksPath", join(root, "hooks"));
  const commit = async () => {
    await git("-C", origin, "add", ".");
    await git("-C", origin, "commit", "-m", "fixture");
  };
  await writeFile(join(origin, "work.txt"), "upstream-v1\n");
  await writeFile(join(origin, "other.txt"), "other-v1\n");
  await commit();
  const reference: ResolvedReference = { alias: "sdk", kind: "git", repository: `file://${origin}`, branch: "main", hidden: false };
  assert.equal(await materializeGitReference(pi, reference), undefined);
  assert.ok(reference.resolvedPath);
  return { root, origin, pi, execute, git, commit, reference, target: reference.resolvedPath, env };
}

describe("real Git preservation", () => {
  it("clones shallowly and refreshes repeatedly from the configured branch", async () => {
    const f = await fixture();
    assert.equal(await f.git("-C", f.target, "rev-parse", "--is-shallow-repository"), "true");
    for (const content of ["upstream-v2\n", "upstream-v3\n"]) {
      await writeFile(join(f.origin, "work.txt"), content);
      await f.commit();
      assert.equal((await synchronizeGitReference(f.pi, f.reference)).action, "refreshed");
      assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), content);
    }
  });

  it("does not delete a checkout when origin validation is cancelled or fails", async () => {
    const f = await fixture();
    await writeFile(join(f.target, "work.txt"), "unsaved\n");
    await writeFile(join(f.target, "untracked.txt"), "keep\n");
    for (const result of [
      { code: 0, killed: true, stdout: "", stderr: "" },
      { code: 128, killed: false, stdout: "", stderr: "validation failed" },
    ]) {
      const pi = { exec: async (_command: string, args: string[], options?: ExecOptions) => args.includes("config") ? result : f.execute("git", args, options) } as ExtensionAPI;
      assert.equal((await synchronizeGitReference(pi, f.reference)).action, "failed");
      assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "unsaved\n");
      assert.equal(await readFile(join(f.target, "untracked.txt"), "utf8"), "keep\n");
    }
    const controller = new AbortController();
    controller.abort();
    assert.equal((await synchronizeGitReference(f.pi, f.reference, { signal: controller.signal })).action, "failed");
    assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "unsaved\n");
  });

  it("preserves an existing checkout with a different origin", async () => {
    const f = await fixture();
    await f.git("-C", f.target, "config", "remote.origin.url", join(f.root, "different"));
    await writeFile(join(f.target, "work.txt"), "unsaved\n");
    assert.ok(await materializeGitReference(f.pi, f.reference));
    assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "unsaved\n");
  });

  it("refuses initially dirty checkouts", async () => {
    const f = await fixture();
    await writeFile(join(f.target, "work.txt"), "unsaved\n");
    assert.equal((await synchronizeGitReference(f.pi, f.reference)).action, "failed");
    assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "unsaved\n");
  });

  for (const kind of ["tracked", "untracked", "ignored", "staged"] as const) {
    it(`preserves ${kind} edits introduced after status`, async () => {
      const f = await fixture();
      const file = kind === "untracked" || kind === "ignored" ? "new.txt" : kind === "staged" ? "other.txt" : "work.txt";
      await writeFile(join(f.origin, kind === "staged" ? "work.txt" : file), "upstream-v2\n");
      await f.commit();
      if (kind === "ignored") await writeFile(join(f.target, ".git", "info", "exclude"), "new.txt\n");
      const pi = { exec: async (command: string, args: string[], options?: ExecOptions) => {
        if (args.includes("fetch")) {
          await writeFile(join(f.target, file), "concurrent-edit\n");
          if (kind === "staged") await f.git("-C", f.target, "add", file);
        }
        return f.execute(command, args, options);
      } } as ExtensionAPI;
      const result = await synchronizeGitReference(pi, f.reference);
      assert.equal(await readFile(join(f.target, file), "utf8"), "concurrent-edit\n");
      assert.equal(result.action, kind === "staged" ? "refreshed" : "failed");
      if (kind === "staged") assert.equal(await f.git("-C", f.target, "status", "--porcelain"), "M  other.txt");
    });
  }

  it("cleans only its cancelled clone after the executor has settled", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let temporary = "";
    const pi = { exec: async (command: string, args: string[], options?: ExecOptions) => {
      const result = await f.execute(command, args, options);
      if (args[0] === "clone") {
        temporary = args.at(-1)!;
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    } } as ExtensionAPI;
    const reference = { ...f.reference, alias: "cancelled", resolvedPath: undefined };
    const operation = materializeGitReference(pi, reference, { signal: controller.signal });
    await waiting;
    controller.abort();
    assert.equal(await readFile(join(temporary, "work.txt"), "utf8"), "upstream-v1\n");
    release();
    assert.match(await operation ?? "", /abort/i);
    assert.equal(reference.resolvedPath, undefined);
    await assert.rejects(readFile(join(temporary, "work.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "upstream-v1\n");
  });

  it("retains a clone when cancellation arrives during its successful publication", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const rename = fs.rename;
    fs.rename = async (...args) => {
      controller.abort();
      return rename(...args);
    };
    syncBuiltinESMExports();
    const reference = { ...f.reference, alias: "published", resolvedPath: undefined };
    try {
      assert.equal(await materializeGitReference(f.pi, reference, { signal: controller.signal }), undefined);
      assert.ok(reference.resolvedPath);
      assert.equal(await readFile(join(reference.resolvedPath, "work.txt"), "utf8"), "upstream-v1\n");
    } finally {
      fs.rename = rename;
      syncBuiltinESMExports();
    }
  });

  it("sync following an in-progress availability check really refreshes", async () => {
    const f = await fixture();
    await writeFile(join(f.origin, "work.txt"), "upstream-v2\n");
    await f.commit();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const pi = { exec: async (command: string, args: string[], options?: ExecOptions) => {
      const result = await f.execute(command, args, options);
      if (args.includes("config") && first) {
        first = false;
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    } } as ExtensionAPI;
    const materializing = materializeGitReference(pi, f.reference);
    await waiting;
    const syncing = synchronizeGitReference(pi, { ...f.reference });
    release();
    assert.equal(await materializing, undefined);
    assert.equal((await syncing).action, "refreshed");
    assert.equal(await readFile(join(f.target, "work.txt"), "utf8"), "upstream-v2\n");
  });

  it("lets separate processes share a clone without replacing published files", { timeout: 10000 }, async () => {
    const f = await fixture();
    const reference = { ...f.reference, alias: "shared", resolvedPath: undefined };
    const script = `
      import { execFile } from 'node:child_process';
      import { once } from 'node:events';
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { materializeGitReference } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)};
      const pi = { exec: async (command, args, options) => {
        const result = await new Promise(resolve => execFile(command, args,
          { signal: options.signal, timeout: options.timeout },
          (error, stdout, stderr) => resolve({ code: error ? 128 : 0, killed: Boolean(error?.killed), stdout, stderr })));
        if (args[0] === 'clone' && result.code === 0) {
          await writeFile(join(args.at(-1), 'sentinel.txt'), 'keep');
          process.send('cloned');
          await once(process, 'message');
        }
        return result;
      }};
      const ref = ${JSON.stringify(reference)};
      const warning = await materializeGitReference(pi, ref);
      process.send({ warning, path: ref.resolvedPath });
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: f.env });
    children.push(child);
    const exited = once(child, "exit");
    assert.equal((await once(child, "message"))[0], "cloned");
    const second = materializeGitReference(f.pi, reference);
    const published = once(child, "message");
    child.send("release");
    const message = (await published)[0] as { warning?: string; path: string };
    assert.equal(message.warning, undefined);
    assert.equal(await second, undefined);
    assert.equal((await exited)[0], 0);
    assert.equal(reference.resolvedPath, message.path);
    assert.equal(await readFile(join(message.path, "sentinel.txt"), "utf8"), "keep");
  });

  it("does not start later batches after cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let operations = 0;
    const pi = { exec: async () => {
      operations++;
      controller.abort();
      return { code: 0, killed: true, stdout: "", stderr: "" };
    } } as unknown as ExtensionAPI;
    const results = await synchronizeAllGitReferences(pi, Array.from({ length: 8 }, (_, i) => ({ ...f.reference, alias: `sdk${i}` })), { signal: controller.signal });
    assert.equal(results.length, 8);
    assert.ok(results.every((result) => result.action === "failed"));
    assert.ok(operations <= 4);
  });
});
