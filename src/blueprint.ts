/** Pure blueprint helpers: source hashing, staleness, lookup, context, and diff → node mapping. */

import type { GraphIndex } from "./graph";
import type { Blueprint, BlueprintNode, Citation } from "./types";
import { absPath, hashString } from "./util";

/** Per-call file cache so hashing a tree reads each file once. */
export class FileLines {
	private cache = new Map<string, string[] | null>();
	constructor(private readonly root: string) {}

	async lines(file: string): Promise<string[] | null> {
		if (!this.cache.has(file)) {
			const f = Bun.file(absPath(this.root, file));
			this.cache.set(file, (await f.exists()) ? (await f.text()).split("\n") : null);
		}
		return this.cache.get(file)!;
	}

	async slice(file: string, start: number, end: number): Promise<string[] | null> {
		const lines = await this.lines(file);
		return lines ? lines.slice(Math.max(0, start - 1), Math.max(0, end)) : null;
	}
}

/** Hash of the cited ranges and the signatures of cited symbols (spec §4.2). */
export async function sourceHash(node: BlueprintNode, index: GraphIndex, files: FileLines): Promise<string> {
	const parts: string[] = [];
	for (const c of [...node.cites].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.start - b.start)) {
		const text = await files.slice(c.file, c.start, c.end);
		const sym = index.symbol(c.symbol);
		parts.push(`${c.symbol}|${c.file}:${c.start}-${c.end}|${sym ? (sym.signature ?? "") : "<missing>"}|${text ? text.join("\n") : "<missing>"}`);
	}
	return hashString(parts.join("\n\0"));
}

export async function hashAll(bp: Blueprint, index: GraphIndex, files: FileLines): Promise<void> {
	for (const node of Object.values(bp.nodes)) node.sourceHash = await sourceHash(node, index, files);
}

/** Recompute hashes against current files; return ids whose hash changed (marking them stale). */
export async function markStale(bp: Blueprint, index: GraphIndex, files: FileLines): Promise<string[]> {
	const stale: string[] = [];
	for (const node of Object.values(bp.nodes)) {
		if (node.id === bp.root) continue;
		const h = await sourceHash(node, index, files);
		if (node.sourceHash !== undefined && h !== node.sourceHash) {
			node.stale = true;
			stale.push(node.id);
		}
	}
	return stale;
}

/** Stale nodes with no stale ancestor: the minimal set of subtrees to re-author. */
export function staleRoots(bp: Blueprint, staleIds: Iterable<string>): string[] {
	const stale = new Set(staleIds);
	const roots: string[] = [];
	for (const id of stale) {
		let p = bp.nodes[id]?.parent;
		let covered = false;
		while (p) {
			if (stale.has(p)) {
				covered = true;
				break;
			}
			p = bp.nodes[p]?.parent;
		}
		if (!covered) roots.push(id);
	}
	return roots;
}

/** All node ids in a subtree, pre-order. */
export function subtreeIds(bp: Blueprint, id: string): string[] {
	const out: string[] = [];
	const visit = (n: string) => {
		const node = bp.nodes[n];
		if (!node) return;
		out.push(n);
		for (const c of node.children) visit(c);
	};
	visit(id);
	return out;
}

/** Replace a subtree with new nodes (first node is the new subtree root, same id). */
export function replaceSubtree(bp: Blueprint, id: string, nodes: BlueprintNode[]): void {
	for (const old of subtreeIds(bp, id)) delete bp.nodes[old];
	for (const n of nodes) bp.nodes[n.id] = n;
}

/** Re-prefix a subtree's ids (used when an unchanged step moves position after a re-overview). */
export function reprefix(nodes: BlueprintNode[], from: string, to: string): BlueprintNode[] {
	const map = (id: string) => (id === from ? to : id.startsWith(from + ".") ? to + id.slice(from.length) : id);
	return nodes.map(n => ({
		...n,
		id: map(n.id),
		parent: n.parent && n.parent !== "root" ? map(n.parent) : n.parent,
		children: n.children.map(map),
		arrows: n.arrows.map(a => ({ ...a, from: map(a.from), to: map(a.to) })),
	}));
}

// ---------------------------------------------------------------------------
// Lookup and context (bp_lookup / bp_context, picks)
// ---------------------------------------------------------------------------

export function nodePath(bp: Blueprint, id: string): string[] {
	const path: string[] = [];
	let cur: string | undefined = id;
	while (cur && cur !== bp.root) {
		const n: BlueprintNode | undefined = bp.nodes[cur];
		if (!n) break;
		path.unshift(n.title);
		cur = n.parent;
	}
	return path;
}

export function findNodes(bp: Blueprint, query: string, limit = 15): BlueprintNode[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const scored: { n: BlueprintNode; score: number }[] = [];
	for (const n of Object.values(bp.nodes)) {
		if (n.id === bp.root) continue;
		let score = -1;
		if (n.id.toLowerCase() === q) score = 0;
		else if (n.cites.some(c => c.symbol.toLowerCase() === q)) score = 1;
		else if (n.title.toLowerCase().includes(q)) score = 2;
		else if (n.cites.some(c => c.symbol.toLowerCase().includes(q) || c.file.toLowerCase().includes(q))) score = 3;
		else if (n.blurb.toLowerCase().includes(q)) score = 4;
		if (score >= 0) scored.push({ n, score });
	}
	// Deeper (more specific) nodes first within a score band.
	scored.sort((a, b) => a.score - b.score || b.n.id.split(".").length - a.n.id.split(".").length);
	return scored.slice(0, limit).map(x => x.n);
}

export function describeNodeLine(bp: Blueprint, n: BlueprintNode): string {
	const flags = [n.stale ? "stale" : "", n.needsReview ? "needs review" : "", n.inferred ? "inferred" : ""].filter(Boolean);
	return `${n.id}  ${nodePath(bp, n.id).join(" › ")}${flags.length ? ` [${flags.join(", ")}]` : ""} — ${n.blurb}`;
}

/** Full context for one node: title, blurb, arrows, children and cited code. */
export async function nodeContext(bp: Blueprint, id: string, files: FileLines, maxLines = 200): Promise<string> {
	const n = bp.nodes[id];
	if (!n) return `No blueprint node ${id}.`;
	const out: string[] = [`# ${nodePath(bp, id).join(" › ") || n.title} (${n.id})`, n.blurb];
	if (n.stale) out.push("(stale: cited code changed since this node was written)");
	if (n.children.length) {
		out.push("", "Parts:");
		for (const c of n.children) {
			const child = bp.nodes[c];
			if (child) out.push(`- ${child.id} ${child.title}: ${child.blurb}`);
		}
	}
	if (n.arrows.length) {
		out.push("", "Arrows (proven = backed by the call graph):");
		for (const a of n.arrows) {
			out.push(`- ${bp.nodes[a.from]?.title ?? a.from} → ${bp.nodes[a.to]?.title ?? a.to}${a.label ? ` (${a.label})` : ""} ${a.proven ? "[proven]" : "[inferred]"}`);
		}
	}
	let budget = maxLines;
	for (const c of n.cites) {
		if (budget <= 0) {
			out.push(`\n… more citations omitted`);
			break;
		}
		const end = Math.min(c.end, c.start + budget - 1);
		const lines = await files.slice(c.file, c.start, end);
		budget -= end - c.start + 1;
		out.push("", `${c.file}:${c.start}-${c.end} (${c.symbol})`, "```", ...(lines ?? ["<file missing>"]), "```");
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// git diff → changed ranges → nodes
// ---------------------------------------------------------------------------

export interface ChangedRange {
	file: string;
	start: number;
	end: number;
}

/** Parse `git diff -U0` output into new-side line ranges (deletions map to the line they collapsed at). */
export function parseUnifiedDiff(diff: string): ChangedRange[] {
	const out: ChangedRange[] = [];
	let file: string | null = null;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) {
			const p = line.slice(4).trim();
			file = p === "/dev/null" ? null : p.replace(/^b\//, "");
			continue;
		}
		const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (m && file) {
			const start = Number(m[1]);
			const count = m[2] === undefined ? 1 : Number(m[2]);
			out.push({ file, start: Math.max(1, start), end: Math.max(1, start + Math.max(count, 1) - 1) });
		}
	}
	return out;
}

export function workingTreeRanges(root: string): ChangedRange[] {
	const proc = Bun.spawnSync(["git", "diff", "-U0", "--no-color", "--no-ext-diff", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return [];
	return parseUnifiedDiff(proc.stdout.toString());
}

const overlaps = (c: Citation, r: ChangedRange) => c.file === r.file && c.start <= r.end && c.end >= r.start;

/** Deepest nodes whose citations intersect a changed range. */
export function nodesForRange(bp: Blueprint, r: ChangedRange): string[] {
	const hits = Object.values(bp.nodes).filter(n => n.cites.some(c => overlaps(c, r)));
	// Ancestors are implied by descendants; keep only the deepest hits.
	return hits.filter(n => !hits.some(o => o.id !== n.id && isAncestor(bp, n.id, o.id))).map(n => n.id);
}

function isAncestor(bp: Blueprint, ancestor: string, id: string): boolean {
	let p = bp.nodes[id]?.parent;
	while (p) {
		if (p === ancestor) return true;
		p = bp.nodes[p]?.parent;
	}
	return false;
}
