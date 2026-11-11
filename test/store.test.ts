import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodesForRange, parseUnifiedDiff, staleRoots } from "../src/blueprint";
import { Store } from "../src/store";
import type { Blueprint, BlueprintNode } from "../src/types";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bp-store-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
	test("picks queue appends, then drains exactly once", async () => {
		const store = new Store(dir);
		await store.appendPick({ id: "1", timestamp: "t", kind: "node", target: "s1" });
		await store.appendPick({ id: "2", timestamp: "t", kind: "range", target: "a.ts:1-3" });
		expect((await store.drainPicks()).map(p => p.id)).toEqual(["1", "2"]);
		expect(await store.drainPicks()).toEqual([]);
	});

	test("ensure() excludes .blueprint/ via .git/info/exclude once, without touching .gitignore", async () => {
		Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
		const store = new Store(dir);
		await store.ensure();
		await store.ensure();
		const exclude = await Bun.file(join(dir, ".git/info/exclude")).text();
		expect(exclude.split("\n").filter(l => l === ".blueprint/")).toHaveLength(1);
		expect(await Bun.file(join(dir, ".gitignore")).exists()).toBe(false);
	});
});

describe("diff mapping", () => {
	test("parses new-side ranges, including pure deletions and new files", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -10,2 +10,3 @@ fn",
			"@@ -30 +31 @@",
			"@@ -50,4 +52,0 @@",
			"diff --git a/new.ts b/new.ts",
			"--- /dev/null",
			"+++ b/new.ts",
			"@@ -0,0 +1,5 @@",
		].join("\n");
		expect(parseUnifiedDiff(diff)).toEqual([
			{ file: "a.ts", start: 10, end: 12 },
			{ file: "a.ts", start: 31, end: 31 },
			{ file: "a.ts", start: 52, end: 52 },
			{ file: "new.ts", start: 1, end: 5 },
		]);
	});

	const n = (id: string, parent: string | undefined, children: string[], cites: BlueprintNode["cites"]): BlueprintNode => ({
		id, parent, children, cites, title: id, blurb: "", arrows: [],
	});
	const bp: Blueprint = {
		version: 1,
		root: "root",
		nodes: {
			root: n("root", undefined, ["s1"], []),
			s1: n("s1", "root", ["s1.1", "s1.2"], [{ symbol: "a.ts#main", file: "a.ts", start: 1, end: 100 }]),
			"s1.1": n("s1.1", "s1", [], [{ symbol: "a.ts#parse", file: "a.ts", start: 10, end: 20 }]),
			"s1.2": n("s1.2", "s1", [], [{ symbol: "a.ts#run", file: "a.ts", start: 30, end: 40 }]),
		},
	};

	test("a changed range marks the deepest intersecting nodes", () => {
		expect(nodesForRange(bp, { file: "a.ts", start: 15, end: 15 })).toEqual(["s1.1"]);
		expect(nodesForRange(bp, { file: "a.ts", start: 25, end: 26 })).toEqual(["s1"]);
		expect(nodesForRange(bp, { file: "b.ts", start: 15, end: 15 })).toEqual([]);
	});

	test("stale roots skip nodes already covered by a stale ancestor", () => {
		expect(staleRoots(bp, ["s1.1", "s1.2"]).sort()).toEqual(["s1.1", "s1.2"]);
		expect(staleRoots(bp, ["s1", "s1.2"])).toEqual(["s1"]);
	});
});
