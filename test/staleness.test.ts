import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLines, hashAll, markStale } from "../src/blueprint";
import { GraphIndex } from "../src/graph";
import type { Blueprint, FactGraph } from "../src/types";

const SOURCE = ["// header", "function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}"].join("\n");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bp-stale-"));
	await Bun.write(join(dir, "m.ts"), SOURCE);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const graph: FactGraph = {
	version: 1,
	symbols: [
		{ id: "m.ts#a", kind: "function", name: "a", range: { file: "m.ts", start: 2, end: 4 } },
		{ id: "m.ts#b", kind: "function", name: "b", range: { file: "m.ts", start: 6, end: 8 } },
	],
	edges: [],
	files: [{ path: "m.ts", hash: "h" }],
};

function blueprint(): Blueprint {
	const node = (id: string, symbol: string, start: number, end: number) => ({
		id, parent: "root", title: id, blurb: "", children: [], arrows: [], cites: [{ symbol, file: "m.ts", start, end }],
	});
	return {
		version: 1,
		root: "root",
		nodes: {
			root: { id: "root", title: "r", blurb: "", children: ["a", "b"], arrows: [], cites: [] },
			a: node("a", "m.ts#a", 2, 4),
			b: node("b", "m.ts#b", 6, 8),
		},
	};
}

async function hashed(): Promise<Blueprint> {
	const bp = blueprint();
	await hashAll(bp, new GraphIndex(graph), new FileLines(dir));
	return bp;
}

describe("staleness", () => {
	test("lines inserted above cited code re-anchor the citations instead of marking them stale", async () => {
		const bp = await hashed();
		await Bun.write(join(dir, "m.ts"), `import x from "y";\n\n${SOURCE}`);
		const { stale, moved } = await markStale(bp, new GraphIndex(graph), new FileLines(dir));
		expect(stale).toEqual([]);
		expect(moved).toBe(true);
		expect(bp.nodes.a.cites[0]).toMatchObject({ start: 4, end: 6 });
		expect(bp.nodes.b.cites[0]).toMatchObject({ start: 8, end: 10 });
	});

	test("an edited body is stale, and only that node", async () => {
		const bp = await hashed();
		await Bun.write(join(dir, "m.ts"), SOURCE.replace("return 2;", "return 3;"));
		const { stale } = await markStale(bp, new GraphIndex(graph), new FileLines(dir));
		expect(stale).toEqual(["b"]);
		expect(bp.nodes.b.stale).toBe(true);
	});

	test("a moved and edited block is still stale", async () => {
		const bp = await hashed();
		await Bun.write(join(dir, "m.ts"), `// new line\n${SOURCE.replace("return 1;", "return 10;")}`);
		const { stale } = await markStale(bp, new GraphIndex(graph), new FileLines(dir));
		expect(stale).toContain("a");
		expect(stale).not.toContain("b");
	});
});
