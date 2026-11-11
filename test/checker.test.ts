import { describe, expect, test } from "bun:test";
import { checkNode, materializeSubmission } from "../src/checker";
import { checkSubtree, salvageSubtree } from "../src/generator";
import { GraphIndex } from "../src/graph";
import type { BlueprintNode, FactGraph, GraphSymbol } from "../src/types";

// a.ts: main(1-40) calls parse(42-60) and run(62-200); run calls helper(b.ts 1-10) calls deep(b.ts 12-20)
const sym = (id: string, start: number, end: number, container?: string): GraphSymbol => ({
	id,
	kind: "function",
	name: id.split("#")[1],
	container,
	range: { file: id.split("#")[0], start, end },
});
const graph: FactGraph = {
	version: 1,
	symbols: [
		sym("a.ts#main", 1, 40),
		sym("a.ts#parse", 42, 60),
		sym("a.ts#run", 62, 200),
		sym("b.ts#helper", 1, 10),
		sym("b.ts#deep", 12, 20),
		sym("c.ts#unrelated", 1, 5),
	],
	edges: [
		{ from: "a.ts#main", to: "a.ts#parse", kind: "calls" },
		{ from: "a.ts#main", to: "a.ts#run", kind: "calls" },
		{ from: "a.ts#run", to: "b.ts#helper", kind: "calls" },
		{ from: "b.ts#helper", to: "b.ts#deep", kind: "calls" },
	],
	files: [],
};
const index = new GraphIndex(graph);

const cite = (id: string, start?: number, end?: number) => {
	const s = index.symbol(id)!;
	return { symbol: id, file: s.range.file, start: start ?? s.range.start, end: end ?? s.range.end };
};
const node = (id: string, cites: ReturnType<typeof cite>[], extra: Partial<BlueprintNode> = {}): BlueprintNode => ({
	id,
	title: "A part",
	blurb: "Does a thing.",
	children: [],
	arrows: [],
	cites,
	...extra,
});

function parentWith(children: BlueprintNode[], extra: Partial<BlueprintNode> = {}) {
	return node("p", [cite("a.ts#main")], { children: children.map(c => c.id), ...extra });
}
const kids = () => [node("p.1", [cite("a.ts#parse")]), node("p.2", [cite("a.ts#run", 62, 100)]), node("p.3", [cite("b.ts#helper")])];
const rules = (r: ReturnType<typeof checkNode>) => r.issues.filter(i => i.severity === "reject").map(i => i.rule);

describe("checker", () => {
	test("a well-formed inner node passes", () => {
		const children = kids();
		const r = checkNode(index, parentWith(children, { arrows: [{ from: "p.1", to: "p.2", proven: false }] }), children);
		expect(r.ok).toBe(true);
	});

	test("C1 rejects unknown symbols, wrong files and ranges outside the symbol", () => {
		for (const bad of [
			{ symbol: "a.ts#nope", file: "a.ts", start: 1, end: 2 },
			{ symbol: "a.ts#parse", file: "b.ts", start: 42, end: 50 },
			{ symbol: "a.ts#parse", file: "a.ts", start: 40, end: 50 },
			{ symbol: "a.ts#parse", file: "a.ts", start: 42, end: 61 },
		]) {
			expect(rules(checkNode(index, node("x", [bad]), []))).toContain("C1");
		}
		expect(rules(checkNode(index, node("x", [cite("a.ts#parse", 42, 60)]), []))).not.toContain("C1");
	});

	test("C2 accepts proven arrows over paths of 1 or 2 edges and rejects longer or reversed ones", () => {
		const children = [node("p.1", [cite("a.ts#run", 62, 100)]), node("p.2", [cite("b.ts#helper")]), node("p.3", [cite("b.ts#deep")])];
		const parent = (arrows: BlueprintNode["arrows"]) => node("p", [cite("a.ts#main")], { children: ["p.1", "p.2", "p.3"], arrows });
		expect(checkNode(index, parent([{ from: "p.1", to: "p.2", proven: true }]), children).ok).toBe(true); // 1 hop
		expect(checkNode(index, parent([{ from: "p.1", to: "p.3", proven: true }]), children).ok).toBe(true); // 2 hops
		expect(rules(checkNode(index, parent([{ from: "p.2", to: "p.1", proven: true }]), children))).toContain("C2"); // reversed
		// 3 hops: main → run → helper → deep
		const far = [node("q.1", [cite("a.ts#main", 1, 10)]), node("q.2", [cite("a.ts#parse")]), node("q.3", [cite("b.ts#deep")])];
		const farParent = node("q", [cite("a.ts#main")], { children: ["q.1", "q.2", "q.3"], arrows: [{ from: "q.1", to: "q.3", proven: true }] });
		expect(rules(checkNode(index, farParent, far))).toContain("C2");
	});

	test("C3: an unprovable arrow is accepted when marked proven: false", () => {
		const children = kids();
		const r = checkNode(index, parentWith(children, { arrows: [{ from: "p.3", to: "p.1", proven: false }] }), children);
		expect(r.ok).toBe(true);
		expect(r.provenArrows).toEqual([false]);
	});

	test("C4 rejects a child citing outside the parent's transitive scope", () => {
		const children = [...kids().slice(0, 2), node("p.3", [cite("c.ts#unrelated")])];
		expect(rules(checkNode(index, parentWith(children), children))).toContain("C4");
		// transitive: deep is reachable main → run → helper → deep
		const deep = [...kids().slice(0, 2), node("p.3", [cite("b.ts#deep")])];
		expect(rules(checkNode(index, parentWith(deep), deep))).not.toContain("C4");
	});

	test("C5 enforces 3-9 children, four-word titles and 25-word blurbs", () => {
		const two = kids().slice(0, 2);
		expect(rules(checkNode(index, parentWith(two), two))).toContain("C5");
		const ten = Array.from({ length: 10 }, (_, i) => node(`p.${i + 1}`, [cite("a.ts#parse")]));
		expect(rules(checkNode(index, parentWith(ten), ten))).toContain("C5");
		expect(rules(checkNode(index, node("x", [cite("a.ts#parse")], { title: "one two three four five" }), []))).toContain("C5");
		expect(rules(checkNode(index, node("x", [cite("a.ts#parse")], { blurb: Array(26).fill("w").join(" ") }), []))).toContain("C5");
		expect(rules(checkNode(index, node("x", [cite("a.ts#parse")], { title: "one two three four", blurb: Array(25).fill("w").join(" ") }), []))).toEqual([]);
	});

	test("C6 requires a leaf to cite a range of 60 lines or fewer", () => {
		expect(rules(checkNode(index, node("x", [cite("a.ts#run")]), []))).toContain("C6"); // 139 lines
		expect(rules(checkNode(index, node("x", [cite("a.ts#run", 62, 121)]), []))).not.toContain("C6"); // exactly 60
	});

	test("C7 only warns when siblings share a symbol", () => {
		const children = [node("p.1", [cite("a.ts#parse")]), node("p.2", [cite("a.ts#parse", 42, 50)]), node("p.3", [cite("b.ts#helper")])];
		const r = checkNode(index, parentWith(children), children);
		expect(r.ok).toBe(true);
		expect(r.issues.map(i => `${i.rule}:${i.severity}`)).toEqual(["C7:warn"]);
	});
});

describe("materializeSubmission", () => {
	test("assigns path ids and remaps arrows by local id, title or position", () => {
		const nodes = materializeSubmission(
			{
				title: "Step",
				blurb: "Root.",
				cites: [cite("a.ts#main")],
				children: [
					{ id: "parse", title: "Parse", blurb: "b." },
					{ id: "run", title: "Run", blurb: "b." },
					{ title: "Help", blurb: "b." },
				],
				arrows: [
					{ from: "parse", to: "run", proven: true },
					{ from: "Run", to: "3" },
				],
			},
			"root",
			"s2",
		);
		expect(nodes.map(n => n.id)).toEqual(["s2", "s2.1", "s2.2", "s2.3"]);
		expect(nodes[0].arrows).toEqual([
			{ from: "s2.1", to: "s2.2", label: undefined, proven: true },
			{ from: "s2.2", to: "s2.3", label: undefined, proven: false },
		]);
		expect(nodes[1].parent).toBe("s2");
	});

	test("rejects arrows that name no sibling", () => {
		expect(() =>
			materializeSubmission({ title: "S", blurb: "b.", children: [{ title: "A", blurb: "b." }], arrows: [{ from: "A", to: "ghost" }] }, "root", "s1"),
		).toThrow(/must name two of its own children/);
	});
});

describe("salvage after failed rounds", () => {
	test("drops unreal and out-of-scope cites and downgrades unprovable proven arrows", () => {
		const nodes = materializeSubmission(
			{
				title: "Step",
				blurb: "b.",
				cites: [cite("a.ts#main")],
				children: [
					{ id: "a", title: "A", blurb: "b.", cites: [cite("a.ts#parse"), { symbol: "a.ts#ghost", file: "a.ts", start: 1, end: 2 }] },
					{ id: "b", title: "B", blurb: "b.", cites: [cite("a.ts#run", 62, 90), cite("c.ts#unrelated")] },
					{ id: "c", title: "C", blurb: "b.", cites: [cite("b.ts#helper")] },
				],
				arrows: [{ from: "c", to: "a", proven: true }],
			},
			"root",
			"s1",
		);
		expect(checkSubtree(index, nodes).ok).toBe(false);
		const fixed = salvageSubtree(index, nodes);
		expect(fixed[1].cites.map(c => c.symbol)).toEqual(["a.ts#parse"]);
		expect(fixed[2].cites.map(c => c.symbol)).toEqual(["a.ts#run"]);
		expect(fixed[0].arrows[0].proven).toBe(false);
		// Every remaining citation is real and every solid arrow is proven.
		expect(checkSubtree(index, fixed).issues.filter(i => i.rule === "C1" || i.rule === "C2" || i.rule === "C4")).toEqual([]);
	});
});
