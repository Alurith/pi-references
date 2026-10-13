import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { withFileLock } from "../src/file-lock.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function resource() {
  const root = await mkdtemp(join(tmpdir(), "references-lock-"));
  roots.push(root);
  return join(root, "resource");
}
function worker(path: string) {
  const script = `
    import { once } from 'node:events';
    import { appendFile } from 'node:fs/promises';
    import { withFileLock } from ${JSON.stringify(new URL("../src/file-lock.ts", import.meta.url).href)};
    process.send('ready');
    await withFileLock(${JSON.stringify(path)}, async () => {
      await appendFile(${JSON.stringify(`${path}.events`)}, 'enter\\n');
      process.send('entered');
      await once(process, 'message');
      await appendFile(${JSON.stringify(`${path}.events`)}, 'leave\\n');
    });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  children.push(child);
  let ready!: () => void;
  let entered!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  child.on("message", (message) => {
    if (message === "ready") ready();
    if (message === "entered") entered();
  });
  return { child, ready: readyPromise, entered: enteredPromise, exited: once(child, "exit") };
}

describe("cross-process file locks", () => {
  it("serializes callbacks for an absent resource and releases after failures", async () => {
    const path = await resource();
    await assert.rejects(withFileLock(path, async () => { throw new Error("original failure"); }), /original failure/);
    await withFileLock(path, async () => { await writeFile(path, "saved"); });
    assert.equal(await readFile(path, "utf8"), "saved");
    await assert.rejects(readFile(`${path}.lock`), { code: "ENOENT" });
  });

  it("prevents separate processes from entering together", { timeout: 10000 }, async () => {
    const path = await resource();
    const first = worker(path);
    await first.entered;
    const second = worker(path);
    await second.ready;
    first.child.send("release");
    assert.equal((await first.exited)[0], 0);
    await second.entered;
    second.child.send("release");
    assert.equal((await second.exited)[0], 0);
    assert.equal(await readFile(`${path}.events`, "utf8"), "enter\nleave\nenter\nleave\n");
  });

  it("cancels a waiter without any later callback or acquisition", async () => {
    const path = await resource();
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const owner = withFileLock(path, async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await active;
    const controller = new AbortController();
    let ran = false;
    const waiter = withFileLock(path, async () => { ran = true; }, controller.signal);
    controller.abort();
    await assert.rejects(waiter, { name: "AbortError" });
    release();
    await owner;
    await withFileLock(path, async () => {});
    assert.equal(ran, false);
  });

  it("aborts active work when the lock is compromised without publishing", { timeout: 15000 }, async () => {
    const path = await resource();
    await assert.rejects(withFileLock(path, async (signal) => {
      await rm(`${path}.lock`, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Lock loss was not detected")), 12000);
        signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      signal.throwIfAborted();
      await writeFile(path, "must not publish");
    }), /ENOENT|compromised/i);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await withFileLock(path, async () => { await writeFile(path, "new owner"); });
    assert.equal(await readFile(path, "utf8"), "new owner");
  });

  it("recovers a lock after its owning process is killed", { timeout: 45000 }, async () => {
    const path = await resource();
    const owner = worker(path);
    await owner.entered;
    owner.child.kill("SIGKILL");
    await owner.exited;
    await withFileLock(path, async () => { await writeFile(path, "recovered"); });
    assert.equal(await readFile(path, "utf8"), "recovered");
  });
});
