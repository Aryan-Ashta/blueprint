/**
 * Indexer: language servers → fact graph (spec §5, step 1). Never written by a model.
 *
 * Pass 1: `textDocument/documentSymbol` for every changed file the servers
 * handle. Pass 2 (once every symbol is known, so cross-file targets resolve):
 * `prepareCallHierarchy` + `callHierarchy/outgoingCalls` for each callable,
 * and `imports` edges from import statements. Unchanged files (same content
 * hash) carry their symbols and outgoing edges forward.
 */

import type { CallHierarchyItem, DocumentSymbol, LspClient, LspRegistry } from "./lsp";
import { uriToPath } from "./lsp";
import type { FactGraph, GraphEdge, GraphSymbol, SymbolKind } from "./types";
import { absPath, hashFile, relPath, stableId } from "./util";

export interface IndexOptions {
	/** Repo-relative scope; only files under it are indexed. */
	scope?: string;
	/** Cap on symbols per build (spec §14 "Large repositories"). */
	maxSymbols: number;
	/** Previous graph: files with an unchanged hash are carried forward. */
	previous?: FactGraph;
	onProgress?: (msg: string) => void;
}

export interface IndexResult {
	graph: FactGraph;
	/** Files (re-)indexed through a language server. */
	indexed: number;
	/** Unchanged files carried forward. */
	skipped: number;
	serversUsed: string[];
	truncated: boolean;
	/** First few per-file failures (no server, server errors), for diagnostics. */
	errors: string[];
}

const NOISE_RE = /(^|\/)(node_modules|\.blueprint|dist|build|out|target|vendor|\.git|\.omp|__pycache__|\.venv|venv)(\/|$)/;
/** Qualified name of the per-file module symbol. */
export const MODULE = "<module>";

/** Tracked plus untracked-but-not-ignored files under scope, minus vendored/build dirs. */
export function listSourceFiles(root: string, scope: string): string[] {
	const proc = Bun.spawnSync(["git", "ls-files", "-c", "-o", "--exclude-standard", "--", scope], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return [];
	return [...new Set(proc.stdout.toString().split("\n").map(l => l.trim()))].filter(f => f && !NOISE_RE.test(f)).sort();
}

/** LSP SymbolKind → our coarse kinds; null for kinds that are not worth a graph node. */
function mapKind(kind: number): SymbolKind | null {
	switch (kind) {
		case 2: case 3: case 4: return "module"; // module, namespace, package
		case 5: case 11: case 23: return "class"; // class, interface, struct
		case 6: case 9: return "method"; // method, constructor
		case 12: return "function";
		case 10: case 26: return "type"; // enum, type parameter
		case 14: case 13: return "constant"; // constant, variable
		default: return null; // properties, fields, enum members, literals …
	}
}

interface FileSymbols {
	file: string;
	client: LspClient;
	symbols: GraphSymbol[];
	/** symbol id → selection position (0-based) for call hierarchy */
	positions: Map<string, { line: number; character: number }>;
}

function collect(doc: DocumentSymbol, file: string, prefix: string, container: string | undefined, out: FileSymbols, seen: Map<string, number>): void {
	// Anonymous entries ("map() callback", "<function>") are not addressable parts.
	if (/[\s()<>]/.test(doc.name)) return;
	const kind = mapKind(doc.kind);
	const qualified = prefix ? `${prefix}.${doc.name}` : doc.name;
	let nextContainer = container;
	let nextPrefix = prefix;
	if (kind) {
		const n = seen.get(qualified) ?? 0;
		seen.set(qualified, n + 1);
		// Variables only at top level: locals inside functions are noise.
		if (kind !== "constant" || !container) {
			const sym: GraphSymbol = {
				id: stableId(file, qualified, n),
				kind,
				name: qualified,
				container,
				range: { file, start: doc.range.start.line + 1, end: doc.range.end.line + 1 },
				signature: doc.detail?.trim().slice(0, 200) || undefined,
			};
			out.symbols.push(sym);
			out.positions.set(sym.id, doc.selectionRange.start);
			nextContainer = sym.id;
		}
		nextPrefix = qualified;
	}
	if (kind === "constant" || kind === "function" || kind === "method") {
		// Don't descend into bodies: nested locals are not part of the map.
		if (kind !== "constant") for (const c of doc.children ?? []) if (mapKind(c.kind) === "function" || mapKind(c.kind) === "class") collect(c, file, nextPrefix, nextContainer, out, seen);
		return;
	}
	for (const child of doc.children ?? []) collect(child, file, nextPrefix, nextContainer, out, seen);
}

export async function indexProject(root: string, registry: LspRegistry, opts: IndexOptions): Promise<IndexResult> {
	const files = listSourceFiles(root, opts.scope ?? ".");
	const prevFiles = new Map((opts.previous?.files ?? []).map(f => [f.path, f]));
	const symbols: GraphSymbol[] = [];
	const edges: GraphEdge[] = [];
	const graphFiles: FactGraph["files"] = [];
	const fresh: FileSymbols[] = [];
	const serversUsed = new Set<string>();
	let truncated = false;
	let skipped = 0;
	const errors: string[] = [];
	const noteError = (msg: string) => {
		if (errors.length < 5) errors.push(msg);
	};

	// Pass 1: symbols.
	for (const file of files) {
		if (symbols.length >= opts.maxSymbols) {
			truncated = true;
			break;
		}
		const abs = absPath(root, file);
		const hash = await hashFile(abs);
		if (hash === null) continue;
		const prev = prevFiles.get(file);
		if (prev && prev.hash === hash && opts.previous) {
			symbols.push(...opts.previous.symbols.filter(s => s.range.file === file));
			edges.push(...opts.previous.edges.filter(e => e.from.startsWith(`${file}#`)));
			graphFiles.push(prev);
			skipped++;
			continue;
		}
		const client = await registry.clientForFile(file);
		if (!client) {
			noteError(`${file}: no language server for this file type`);
			continue;
		}
		opts.onProgress?.(`symbols: ${file}`);
		let docs: DocumentSymbol[];
		try {
			docs = await client.documentSymbol(abs);
		} catch (err) {
			noteError(`${file}: ${client.name}: ${(err as Error).message}`);
			continue;
		}
		serversUsed.add(client.name);
		const fs: FileSymbols = { file, client, symbols: [], positions: new Map() };
		const seen = new Map<string, number>();
		for (const d of docs) collect(d, file, "", undefined, fs, seen);
		// The file itself is a module symbol: the source of its imports and the container of its top level.
		const lineCount = (await Bun.file(abs).text()).split("\n").length;
		const moduleSym: GraphSymbol = { id: stableId(file, MODULE), kind: "module", name: MODULE, range: { file, start: 1, end: lineCount } };
		symbols.push(moduleSym, ...fs.symbols);
		for (const s of fs.symbols) edges.push({ from: s.container ?? moduleSym.id, to: s.id, kind: "contains" });
		graphFiles.push({ path: file, hash, server: client.name });
		fresh.push(fs);
	}

	const byFile = new Map<string, GraphSymbol[]>();
	for (const s of symbols) {
		const list = byFile.get(s.range.file) ?? [];
		list.push(s);
		byFile.set(s.range.file, list);
	}

	// Pass 2: calls and imports for re-indexed files.
	for (const fs of fresh) {
		const abs = absPath(root, fs.file);
		const client = fs.client;
		opts.onProgress?.(`calls: ${fs.file}`);
		for (const sym of fs.symbols) {
			if (sym.kind !== "function" && sym.kind !== "method") continue;
			const pos = fs.positions.get(sym.id)!;
			let ch = await registry.callHierarchyClient(client);
			let items = await ch.prepareCallHierarchy(abs, pos.line, pos.character);
			if (items === null && ch === client) {
				// OMP's client may have just been refused; retry on the fallback once.
				const fb = await registry.callHierarchyClient(client);
				if (fb !== client) {
					ch = fb;
					items = await ch.prepareCallHierarchy(abs, pos.line, pos.character);
				}
			}
			const item = items?.[0];
			if (!item) continue;
			const outgoing = (await ch.outgoingCalls(item)) ?? [];
			for (const call of outgoing) {
				const target = resolveTarget(call.to, root, byFile);
				if (!target || target.id === sym.id) continue;
				const site = call.fromRanges[0];
				edges.push({ from: sym.id, to: target.id, kind: "calls", site: { file: fs.file, line: (site?.start.line ?? pos.line) + 1 } });
			}
		}
		const text = await Bun.file(abs).text();
		const moduleId = stableId(fs.file, MODULE);
		for (const imp of extractImports(fs.file, text)) {
			const target = resolveImport(imp, fs.file, byFile);
			if (target) edges.push({ from: moduleId, to: target.id, kind: "imports", site: { file: fs.file, line: imp.line } });
		}
	}

	// Drop edges whose endpoints vanished (renamed/deleted symbols) and duplicates.
	const ids = new Set(symbols.map(s => s.id));
	const unique = new Map<string, GraphEdge>();
	for (const e of edges) {
		if (!ids.has(e.from) || !ids.has(e.to)) continue;
		unique.set(`${e.kind}|${e.from}|${e.to}|${e.site?.line ?? ""}`, e);
	}
	return {
		graph: { version: 1, symbols, edges: [...unique.values()], files: graphFiles },
		indexed: fresh.length,
		skipped,
		serversUsed: [...serversUsed],
		errors,
		truncated,
	};
}

/** The innermost graph symbol whose range contains the call-hierarchy target. */
function resolveTarget(item: CallHierarchyItem, root: string, byFile: Map<string, GraphSymbol[]>): GraphSymbol | null {
	const file = relPath(root, uriToPath(item.uri));
	const line = item.selectionRange.start.line + 1;
	let best: GraphSymbol | null = null;
	for (const s of byFile.get(file) ?? []) {
		if (s.range.start <= line && s.range.end >= line && (!best || s.range.end - s.range.start < best.range.end - best.range.start)) best = s;
	}
	return best;
}

// ---------------------------------------------------------------------------
// Imports (text-level; a miss is only a missing edge, never a wrong one)
// ---------------------------------------------------------------------------

export interface ImportRef {
	/** Imported names (empty for whole-module imports). */
	names: string[];
	/** Module specifier as written. */
	module: string;
	line: number;
}

export function extractImports(file: string, text: string): ImportRef[] {
	const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	const refs: ImportRef[] = [];
	const lineAt = (idx: number) => text.slice(0, idx).split("\n").length;
	const names = (list: string) =>
		list
			.split(",")
			.map(p => p.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].replace(/[(){}]/g, "").trim())
			.filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
	if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) {
		for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g)) {
			const clause = m[1];
			const named = /\{([^}]*)\}/.exec(clause);
			const def = /^([A-Za-z_$][\w$]*)/.exec(clause.trim());
			refs.push({ names: [...(named ? names(named[1]) : []), ...(def ? [def[1]] : [])], module: m[2], line: lineAt(m.index ?? 0) });
		}
	} else if (ext === "py") {
		for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\(?([^)\n]+)\)?/gm)) {
			refs.push({ names: names(m[2]), module: m[1], line: lineAt(m.index ?? 0) });
		}
		for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) refs.push({ names: [], module: m[1], line: lineAt(m.index ?? 0) });
	} else if (ext === "go") {
		for (const m of text.matchAll(/"([\w./-]+)"/g)) {
			const before = text.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0);
			if (/\bimport\s*(\(\s*[^)]*)?$/.test(before)) refs.push({ names: [], module: m[1], line: lineAt(m.index ?? 0) });
		}
	} else if (ext === "rs") {
		for (const m of text.matchAll(/\buse\s+(?:crate|super|self)::([\w:]+?)(?:::\{([^}]*)\})?\s*;/g)) {
			const path = m[1].split("::");
			const listed = m[2] ? names(m[2]) : [path.pop() ?? ""];
			refs.push({ names: listed.filter(Boolean), module: path.join("/"), line: lineAt(m.index ?? 0) });
		}
	}
	return refs;
}

/**
 * Resolve an import to a symbol in another indexed file: the module path must
 * plausibly name that file, and the imported name must be a top-level symbol in it.
 */
function resolveImport(imp: ImportRef, fromFile: string, byFile: Map<string, GraphSymbol[]>): GraphSymbol | null {
	const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
	const candidates: string[] = [];
	if (imp.module.startsWith(".")) {
		const joined = normalizePath(`${dir}/${imp.module}`);
		candidates.push(joined);
	} else {
		candidates.push(imp.module.replaceAll(".", "/"), imp.module);
	}
	const files = [...byFile.keys()].filter(f => {
		if (f === fromFile) return false;
		const noExt = f.replace(/\.[^/.]+$/, "");
		return candidates.some(c => noExt === c || noExt === `${c}/index` || noExt === `${c}/__init__` || noExt === `${c}/mod` || noExt.endsWith(`/${c}`));
	});
	for (const f of files) {
		const tops = (byFile.get(f) ?? []).filter(s => !s.container && s.name !== MODULE);
		for (const name of imp.names) {
			const hit = tops.find(s => s.name === name);
			if (hit) return hit;
		}
		if (imp.names.length === 0 && tops[0]) return tops[0];
	}
	return null;
}

function normalizePath(p: string): string {
	const out: string[] = [];
	for (const part of p.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}
