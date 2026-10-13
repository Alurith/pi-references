import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { createReferencesAutocompleteProvider } from "../src/autocomplete.ts";
import { expandReferencesInText } from "../src/transform.ts";
import { findReferenceTokens, parseReferenceQueryAtCursor } from "../src/tokenize.ts";
import type { ResolvedReference } from "../src/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "references-completion-"));
  roots.push(root);
  const references: ResolvedReference[] = [{ alias: "docs", kind: "local", resolvedPath: root, hidden: false }];
  const native = new CombinedAutocompleteProvider([], root);
  const provider = createReferencesAutocompleteProvider(references, async () => {})(native);
  const suggest = (line: string, col = line.length) => provider.getSuggestions([line], 0, col, { signal: new AbortController().signal });
  return { root, references, native, provider, suggest };
}

describe("reference completion round trips", () => {
  for (const [filename, query, token] of [
    ["guide.md", "gui", "@docs/guide.md"],
    ["hello world.md", "hel", '@"docs/hello world.md"'],
    ['quoted"name.md', "quo", '@"docs/quoted\\\"name.md"'],
    ["back\\slash.md", "bac", '@"docs/back\\\\slash.md"'],
    ["comma,.md", "com", '@"docs/comma,.md"'],
  ]) {
    it(`completes and resolves the real filename ${filename}`, async () => {
      const f = await fixture();
      await writeFile(join(f.root, filename), "fixture");
      const line = `@docs/${query}`;
      const suggestions = await f.suggest(line);
      assert.ok(suggestions);
      const item = suggestions.items.find((item) => item.label.includes(filename));
      assert.ok(item);
      assert.equal(item.value, token);
      const completion = f.provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
      assert.equal(expandReferencesInText(completion.lines[0], f.references), `${token} [resolved: ${join(f.root, filename)}] `);
    });
  }

  it("continues completion inside a quoted directory without duplicate quotes", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "product docs"));
    await writeFile(join(f.root, "product docs", "guide.md"), "fixture");
    const first = "@docs/pro";
    const suggestions = await f.suggest(first);
    assert.ok(suggestions);
    const directory = suggestions.items.find((item) => item.label.endsWith("product docs/"));
    assert.ok(directory);
    assert.equal(directory.value, '@"docs/product docs/"');
    const completed = f.provider.applyCompletion([first], 0, first.length, directory, suggestions.prefix);
    assert.equal(completed.lines[0], '@"docs/product docs/"');
    assert.equal(completed.cursorCol, completed.lines[0].length - 1);
    const next = await f.suggest(completed.lines[0], completed.cursorCol);
    assert.ok(next);
    const file = next.items.find((item) => item.label.endsWith("guide.md"));
    assert.ok(file);
    assert.equal(file.value, '@"docs/product docs/guide.md"');
    const result = f.provider.applyCompletion(completed.lines, 0, completed.cursorCol, file, next.prefix);
    assert.equal(result.lines[0], '@"docs/product docs/guide.md" ');
    assert.equal(expandReferencesInText(result.lines[0], f.references), `@"docs/product docs/guide.md" [resolved: ${join(f.root, "product docs", "guide.md")}] `);
  });

  it("preserves text after an existing closing quote", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "hello world.md"), "fixture");
    const line = '@"docs/hel" afterwards';
    const col = line.indexOf('" afterwards');
    const suggestions = await f.suggest(line, col);
    assert.ok(suggestions);
    const item = suggestions.items.find((item) => item.label.includes("hello world.md"));
    assert.ok(item);
    const result = f.provider.applyCompletion([line], 0, col, item, suggestions.prefix);
    assert.equal(result.lines[0], '@"docs/hello world.md"  afterwards');
  });

  it("separates prose wrappers while preserving literal punctuation inside quoted paths", async () => {
    const f = await fixture();
    for (const [opening, closing] of [['"', '"'], ["'", "'"], ["[", "]"], ["(", ")"], ["<", ">"], ["“", "”"], ["（", "）"]]) {
      const text = `${opening}@docs/guide.md${closing}`;
      assert.equal(expandReferencesInText(text, f.references), `${opening}@docs/guide.md [resolved: ${join(f.root, "guide.md")}]${closing}`);
    }
    assert.equal(expandReferencesInText('@"docs/guide.md]"', f.references), `@"docs/guide.md]" [resolved: ${join(f.root, "guide.md]")}]`);
    assert.equal(expandReferencesInText('@"docs/hello world.md", then @docs/guide.md', f.references), `@"docs/hello world.md" [resolved: ${join(f.root, "hello world.md")}], then @docs/guide.md [resolved: ${join(f.root, "guide.md")}]`);
  });

  it("does not expand incomplete or invalid quoted tokens", () => {
    for (const text of ['@"docs/unfinished', '@"docs/bad\\q"', '@"docs/unterminated @docs/file']) {
      assert.deepEqual(findReferenceTokens(text), []);
    }
    assert.deepEqual(parseReferenceQueryAtCursor('@"docs/hello wor'), { aliasQuery: "docs", pathQuery: "hello wor", prefix: '@"docs/hello wor' });
    assert.equal(parseReferenceQueryAtCursor('@"docs/bad\\q'), undefined);
  });

  it("applies the same path boundary checks to quoted references", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "references-outside-"));
    roots.push(outside);
    await symlink(outside, join(f.root, "external"));
    for (const text of ['@"docs/../escape"', '@"docs//absolute"', '@"docs/external/secret"']) {
      assert.equal(expandReferencesInText(text, f.references), text);
    }
  });

  it("keeps bare @ native and hidden aliases out of completion", async () => {
    const f = await fixture();
    f.references[0].hidden = true;
    const signal = new AbortController().signal;
    assert.deepEqual(await f.suggest("@"), await f.native.getSuggestions(["@"], 0, 1, { signal }));
    const suggestions = await f.suggest("@do");
    assert.ok(!suggestions?.items.some((item) => item.value === "@docs"));
  });
});
