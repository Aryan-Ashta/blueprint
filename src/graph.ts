/**
 * Graph queries over the fact graph: the only view of the code the author
 * subagents get (through graph tools), and the substrate the checker checks
 * against.
 */

import type { FactGraph, GraphSymbol } from "./types";

export class GraphIndex {
	readonly symbols: Map<string, GraphSymbol>;
	/** qualified-name suffix → ids */
	readonly byName: Map<string, string[]>;
	/** file → symbols in that file */
	readonly byFile: Map<string, GraphSymbol[]>;
	/** from-id → outgoing edges */
	readonly outgoing: Map<string, FactGraph["edges"]>;
	/** to-id → incoming edges */
	readonly incoming: Map<string, FactGraph["edges"]>;

	constructor(readonly graph: FactGraph) {
		this.symbols = new Map(graph.symbols.map(s => [s.id, s]));
		this.byName = new Map();
		this.byFile = new Map();
		for (const s of graph.symbols) {
			const names = this.byName.get(s.name) ?? [];
			names.push(s.id);
			this.byName.set(s.name, names);
			const leaf = s.name.split(".").pop() ?? s.name;
			if (leaf !== s.name) {
				const leafNames = this.byName.get(leaf) ?? [];
				leafNames.push(s.id);
				this.byName.set(leaf, leafNames);
			}
			const files = this.byFile.get(s.range.file) ?? [];
			files.push(s);
			this.byFile.set(s.range.file, files);
		}
		this.outgoing = new Map();
		this.incoming = new Map();
		for (const e of graph.edges) {
			const out = this.outgoing.get(e.from) ?? [];
			out.push(e);
			this.outgoing.set(e.from, out);
			const inc = this.incoming.get(e.to) ?? [];
			inc.push(e);
			this.incoming.set(e.to, inc);
		}
	}

	symbol(id: string): GraphSymbol | undefined {
		return this.symbols.get(id);
	}

	/** Outgoing calls/imports from a symbol. */
	callees(id: string, kinds: ("calls" | "imports")[] = ["calls", "imports"]): GraphSymbol[] {
		const out: GraphSymbol[] = [];
		for (const e of this.outgoing.get(id) ?? []) {
			if (!kinds.includes(e.kind as "calls" | "imports")) continue;
			const target = this.symbols.get(e.to);
			if (target) out.push(target);
		}
		return out;
	}

	/** Incoming calls/imports to a symbol. */
	callers(id: string, kinds: ("calls" | "imports")[] = ["calls", "imports"]): GraphSymbol[] {
		const out: GraphSymbol[] = [];
		for (const e of this.incoming.get(id) ?? []) {
			if (!kinds.includes(e.kind as "calls" | "imports")) continue;
			const source = this.symbols.get(e.from);
			if (source) out.push(source);
		}
		return out;
	}

	/** Children (contains edges). */
	children(id: string): GraphSymbol[] {
		return (this.outgoing.get(id) ?? [])
			.filter(e => e.kind === "contains")
			.map(e => this.symbols.get(e.to))
			.filter((s): s is GraphSymbol => !!s);
	}

	/** Text search over names, signatures and summaries. */
	search(query: string, limit = 20): GraphSymbol[] {
		const q = query.toLowerCase();
		const scored: { s: GraphSymbol; score: number }[] = [];
		for (const s of this.graph.symbols) {
			let score = -1;
			if (s.name.toLowerCase().includes(q)) score = 0;
			else if (s.signature?.toLowerCase().includes(q)) score = 1;
			else if (s.doc?.toLowerCase().includes(q)) score = 2;
			else if (s.range.file.toLowerCase().includes(q)) score = 3;
			if (score >= 0) scored.push({ s, score });
		}
		scored.sort((a, b) => a.score - b.score || a.s.range.file.localeCompare(b.s.range.file));
		return scored.slice(0, limit).map(x => x.s);
	}

	/** Most-called symbols, for the overview prompt. */
	mostCalled(limit = 30): GraphSymbol[] {
		const counts = new Map<string, number>();
		for (const e of this.graph.edges) {
			if (e.kind !== "calls") continue;
			counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([id]) => this.symbols.get(id))
			.filter((s): s is GraphSymbol => !!s);
	}

	/** Entry points detected from manifests (package.json, pyproject.toml, main.go, lib.rs, …). */
	entryPoints(): GraphSymbol[] {
		const markers: { file: string; names: string[] }[] = [];
		const files = new Set(this.graph.files.map(f => f.path));
		if (files.has("package.json")) markers.push({ file: "package.json", names: ["main", "start", "run"] });
		if (files.has("pyproject.toml")) markers.push({ file: "pyproject.toml", names: ["main"] });
		if (files.has("main.go")) markers.push({ file: "main.go", names: ["main"] });
		if (files.has("src/main.rs")) markers.push({ file: "src/main.rs", names: ["main"] });
		if (files.has("src/lib.rs")) markers.push({ file: "src/lib.rs", names: [] });
		const out: GraphSymbol[] = [];
		for (const m of markers) {
			for (const name of m.names) {
				const syms = this.byName.get(name) ?? [];
				for (const id of syms) {
					const s = this.symbols.get(id);
					if (s) out.push(s);
				}
			}
		}
		// export-like fallback: symbols with many callers but no container
		if (out.length === 0) {
			for (const s of this.mostCalled(20)) if (!s.container) out.push(s);
		}
		return out;
	}
}
