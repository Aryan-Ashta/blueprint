/**
 * Generator (spec §5, steps 2–5): summaries, overview, then one restricted
 * author session per top-level step, each repaired against the checker.
 *
 * Model sessions are reached only through the injected `AgentRunner`, which
 * the OMP adapter implements; this module never touches OMP's API.
 */

import { checkNode, materializeSubmission, scopeOf, type RawSubmission } from "./checker";
import type { GraphIndex } from "./graph";
import type { BlueprintNode, Citation, GraphSymbol } from "./types";
import { wordCount } from "./util";

// ---------------------------------------------------------------------------
// Runner contract (implemented by the adapter)
// ---------------------------------------------------------------------------

/** A tool exposed to a model session. All parameters are strings (JSON where structured). */
export interface RunnerTool {
	name: string;
	description: string;
	params: Record<string, string>; // param name → description
	execute(args: Record<string, string>): Promise<string>;
}

export type ModelRole = "overview" | "author" | "summary";

export interface RunRequest {
	role: ModelRole;
	system: string;
	prompt: string;
	tools: RunnerTool[];
	/** True once the session produced what it was asked for; the runner nudges until then. */
	isDone(): boolean;
	signal?: AbortSignal;
}

export interface AgentRunner {
	run(req: RunRequest): Promise<void>;
}

export type RunLogger = (entry: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Graph tools (the authors' only view of the code)
// ---------------------------------------------------------------------------

function describeSymbol(s: GraphSymbol): Record<string, unknown> {
	return {
		id: s.id,
		kind: s.kind,
		file: s.range.file,
		lines: `${s.range.start}-${s.range.end}`,
		signature: s.signature,
		doc: s.doc,
		summary: s.summary ? `(model-written) ${s.summary}` : undefined,
	};
}

const brief = (s: GraphSymbol) => `${s.id} [${s.kind}] ${s.range.start}-${s.range.end}${s.summary ? ` — ${s.summary}` : ""}`;

export function graphTools(index: GraphIndex, log?: RunLogger): RunnerTool[] {
	const logged =
		(name: string, fn: (a: Record<string, string>) => string) =>
		async (args: Record<string, string>) => {
			const out = fn(args);
			log?.({ type: "tool", tool: name, args, bytes: out.length });
			return out;
		};
	return [
		{
			name: "graph_symbol",
			description: "Show one symbol from the fact graph: location, signature, doc, contained symbols, callees and callers.",
			params: { id: "Symbol id, e.g. `src/app.ts#main`" },
			execute: logged("graph_symbol", ({ id }) => {
				const s = index.symbol(id);
				if (!s) return `No symbol ${id}. Use graph_search to find ids.`;
				return JSON.stringify(
					{
						...describeSymbol(s),
						contains: index.children(id).map(brief),
						calls: index.callees(id).map(brief).slice(0, 40),
						calledBy: index.callers(id).map(brief).slice(0, 40),
					},
					null,
					1,
				);
			}),
		},
		{
			name: "graph_callees",
			description: "List symbols a symbol calls or imports.",
			params: { id: "Symbol id" },
			execute: logged("graph_callees", ({ id }) => index.callees(id).map(brief).join("\n") || "(none)"),
		},
		{
			name: "graph_callers",
			description: "List symbols that call or import a symbol.",
			params: { id: "Symbol id" },
			execute: logged("graph_callers", ({ id }) => index.callers(id).map(brief).join("\n") || "(none)"),
		},
		{
			name: "graph_search",
			description: "Search symbols by name, signature, doc or file path.",
			params: { query: "Search text" },
			execute: logged("graph_search", ({ query }) => index.search(query ?? "", 30).map(brief).join("\n") || "(no matches)"),
		},
	];
}

function parseJsonArg<T>(raw: string | undefined, what: string): T {
	if (!raw) throw new Error(`missing ${what}`);
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		throw new Error(`${what} is not valid JSON: ${(err as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Summaries (optional, cheap model)
// ---------------------------------------------------------------------------

export async function summarizeSymbols(
	index: GraphIndex,
	runner: AgentRunner,
	opts: { batchSize?: number; max?: number; signal?: AbortSignal; log?: RunLogger },
): Promise<number> {
	const targets = index.graph.symbols
		.filter(s => !s.summary && (s.kind === "function" || s.kind === "method" || s.kind === "class"))
		.slice(0, opts.max ?? 1500);
	const batchSize = opts.batchSize ?? 60;
	let written = 0;
	for (let i = 0; i < targets.length; i += batchSize) {
		if (opts.signal?.aborted) break;
		const batch = targets.slice(i, i + batchSize);
		const ids = new Set(batch.map(s => s.id));
		let done = false;
		const submit: RunnerTool = {
			name: "submit_summaries",
			description: "Submit one-line summaries for the listed symbols.",
			params: { summaries: 'JSON object mapping symbol id → one line (≤ 15 words), e.g. {"a.ts#f": "Parses flags"}' },
			execute: async ({ summaries }) => {
				const map = parseJsonArg<Record<string, string>>(summaries, "summaries");
				let accepted = 0;
				for (const [id, text] of Object.entries(map)) {
					const sym = index.symbol(id);
					if (!sym || !ids.has(id) || typeof text !== "string") continue;
					sym.summary = text.trim().split("\n")[0].slice(0, 160);
					accepted++;
				}
				written += accepted;
				done = true;
				return `Accepted ${accepted} summaries. You are done.`;
			},
		};
		const listing = batch
			.map(s => `${s.id} (${s.kind}) ${s.signature ?? ""}${s.doc ? ` — doc: ${s.doc.slice(0, 120)}` : ""}`)
			.join("\n");
		await runner.run({
			role: "summary",
			system: SUMMARY_SYSTEM,
			prompt: `Symbols:\n${listing}\n\nCall submit_summaries once with a summary for each symbol.`,
			tools: [submit],
			isDone: () => done,
			signal: opts.signal,
		});
		opts.log?.({ type: "summaries", batch: i / batchSize, accepted: written });
	}
	return written;
}

const SUMMARY_SYSTEM = `You write one-line descriptions of code symbols from their names, signatures and doc comments.
Each line states what the symbol does, in plain words, at most 15 words. Do not speculate beyond the given data.
Reply only by calling submit_summaries.`;

// ---------------------------------------------------------------------------
// Overview (strongest model)
// ---------------------------------------------------------------------------

export interface OverviewStep {
	title: string;
	blurb: string;
	rootSymbols: string[];
}

export function validateOverview(index: GraphIndex, steps: OverviewStep[]): string[] {
	const errors: string[] = [];
	if (!Array.isArray(steps) || steps.length < 3 || steps.length > 9) {
		errors.push(`need 3 to 9 steps, got ${Array.isArray(steps) ? steps.length : "none"}`);
		return errors;
	}
	steps.forEach((s, i) => {
		if (!s.title || wordCount(s.title) > 4) errors.push(`step ${i + 1}: title must be 1-4 words`);
		if (!s.blurb || wordCount(s.blurb) > 25) errors.push(`step ${i + 1}: blurb must be one sentence of at most 25 words`);
		if (!Array.isArray(s.rootSymbols) || s.rootSymbols.length === 0) errors.push(`step ${i + 1}: needs rootSymbols`);
		for (const id of s.rootSymbols ?? []) if (!index.symbol(id)) errors.push(`step ${i + 1}: unknown symbol ${id}`);
	});
	return errors;
}

export function directoryTree(index: GraphIndex, maxLines = 200): string {
	const counts = new Map<string, number>();
	for (const f of index.graph.files) {
		const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.slice(0, maxLines)
		.map(([dir, n]) => `${dir}/ (${n} files)`)
		.join("\n");
}

export async function writeOverview(
	index: GraphIndex,
	runner: AgentRunner,
	opts: { keep?: OverviewStep[]; signal?: AbortSignal; log?: RunLogger },
): Promise<OverviewStep[]> {
	let result: OverviewStep[] | undefined;
	const submit: RunnerTool = {
		name: "submit_overview",
		description: "Submit the ordered top-level steps of the program.",
		params: {
			steps: 'JSON array of 3-9 objects {"title": "≤4 words", "blurb": "one sentence ≤25 words", "rootSymbols": ["symbol ids"]}, in execution order',
		},
		execute: async ({ steps }) => {
			const parsed = parseJsonArg<OverviewStep[]>(steps, "steps");
			const errors = validateOverview(index, parsed);
			opts.log?.({ type: "overview_submit", ok: errors.length === 0, errors });
			if (errors.length > 0) return `Rejected. Fix and resubmit:\n- ${errors.join("\n- ")}`;
			result = parsed;
			return "Accepted. You are done.";
		},
	};
	const entry = index.entryPoints().slice(0, 20).map(brief).join("\n") || "(none detected)";
	const hot = index.mostCalled(40).map(brief).join("\n") || "(no call edges)";
	const keep = opts.keep?.length
		? `\n\nThese steps are unchanged from the previous build; keep them (you may reorder around new steps):\n${JSON.stringify(opts.keep)}`
		: "";
	const prompt = `Directory tree:\n${directoryTree(index)}\n\nEntry points:\n${entry}\n\nMost-called symbols:\n${hot}${keep}\n\nExplore with the graph tools as needed, then call submit_overview.`;
	await runner.run({
		role: "overview",
		system: OVERVIEW_SYSTEM,
		prompt,
		tools: [...graphTools(index, opts.log), submit],
		isDone: () => result !== undefined,
		signal: opts.signal,
	});
	if (!result) throw new Error("overview model did not submit a valid overview");
	return result;
}

const OVERVIEW_SYSTEM = `You map a codebase for a newcomer. You see it only through a fact graph of symbols and call/import edges.
Describe what the program does as 3 to 9 ordered top-level steps — the order in which work happens when it runs (startup → main work → output), not the directory layout.
Each step gets a title of at most four words, one plain sentence of at most 25 words, and the graph symbol ids where that step's code starts (rootSymbols).
Use only ids that exist in the graph. Submit with submit_overview; if rejected, fix exactly the listed problems and resubmit.`;

// ---------------------------------------------------------------------------
// Subtree authoring with check-and-repair
// ---------------------------------------------------------------------------

export interface AuthorTarget {
	/** Final id of the subtree root (e.g. "s2" or "s2.3"). */
	id: string;
	parent?: string;
	title: string;
	blurb: string;
	/** Citations the subtree root is anchored to. */
	cites: Citation[];
	/** Parent's cites, for C4 on the subtree root (absent for top-level steps). */
	parentCites?: Citation[];
}

export interface AuthorResult {
	nodes: BlueprintNode[];
	rounds: number;
	accepted: boolean;
}

export const MAX_ROUNDS = 4;

/** Check every inner node of a materialized subtree, plus C4 for its root against the parent scope. */
export function checkSubtree(index: GraphIndex, nodes: BlueprintNode[], parentCites?: Citation[]) {
	const byId = new Map(nodes.map(n => [n.id, n]));
	const issues: { node: string; rule: string; severity: string; message: string }[] = [];
	const provenByNode = new Map<string, boolean[]>();
	for (const node of nodes) {
		const children = node.children.map(id => byId.get(id)).filter((n): n is BlueprintNode => !!n);
		const result = checkNode(index, node, children);
		provenByNode.set(node.id, result.provenArrows);
		for (const issue of result.issues) issues.push({ node: node.id, ...issue });
	}
	if (parentCites && nodes[0]) {
		const scope = scopeOf(index, parentCites);
		for (const c of nodes[0].cites) {
			if (!scope.has(c.symbol)) {
				issues.push({ node: nodes[0].id, rule: "C4", severity: "reject", message: `cites ${c.symbol}, outside the parent's scope` });
			}
		}
	}
	return { ok: !issues.some(i => i.severity === "reject"), issues, provenByNode };
}

/**
 * Make a subtree that failed MAX_ROUNDS acceptable: drop citations that are
 * not real (C1) or out of scope (C4), downgrade unprovable arrows to inferred
 * (C2), and flag the nodes for review. Size rules are left as written.
 */
export function salvageSubtree(index: GraphIndex, nodes: BlueprintNode[], parentCites?: Citation[]): BlueprintNode[] {
	const byId = new Map(nodes.map(n => [n.id, n]));
	for (const node of nodes) {
		node.cites = node.cites.filter(c => {
			const s = index.symbol(c.symbol);
			return !!s && s.range.file === c.file && c.start >= s.range.start && c.end <= s.range.end;
		});
	}
	for (const node of nodes) {
		// Nodes are in pre-order, so a parent's cites are filtered before its children's.
		const anchor = node.parent && byId.has(node.parent) ? byId.get(node.parent)!.cites : parentCites;
		if (!anchor) continue;
		const scope = scopeOf(index, anchor);
		node.cites = node.cites.filter(c => scope.has(c.symbol));
	}
	for (const node of nodes) {
		const children = node.children.map(id => byId.get(id)).filter((n): n is BlueprintNode => !!n);
		const { provenArrows, issues } = checkNode(index, node, children);
		node.arrows = node.arrows.map((a, i) => ({ ...a, proven: a.proven && provenArrows[i] === true }));
		if (issues.some(i => i.severity === "reject")) node.needsReview = true;
	}
	return nodes;
}

export async function authorSubtree(
	index: GraphIndex,
	runner: AgentRunner,
	target: AuthorTarget,
	opts: { signal?: AbortSignal; log?: RunLogger } = {},
): Promise<AuthorResult> {
	let rounds = 0;
	let accepted: BlueprintNode[] | undefined;
	let last: BlueprintNode[] | undefined;
	const submit: RunnerTool = {
		name: "submit_node",
		description: "Submit the subtree for this step. Errors come back as the result; fix them and resubmit.",
		params: { tree: SUBMIT_TREE_DOC },
		execute: async ({ tree }) => {
			if (accepted || rounds >= MAX_ROUNDS) return "Already finished. Stop.";
			rounds++;
			let nodes: BlueprintNode[];
			try {
				const raw = parseJsonArg<RawSubmission>(tree, "tree");
				// The root keeps the overview's identity; the author refines its content.
				nodes = materializeSubmission({ ...raw, title: raw.title ?? target.title, blurb: raw.blurb ?? target.blurb }, target.parent, target.id);
			} catch (err) {
				opts.log?.({ type: "submit", node: target.id, round: rounds, error: (err as Error).message });
				return `Rejected (round ${rounds}/${MAX_ROUNDS}): ${(err as Error).message}`;
			}
			if (nodes[0].cites.length === 0) nodes[0].cites = target.cites;
			last = nodes;
			const verdict = checkSubtree(index, nodes, target.parentCites);
			opts.log?.({ type: "verdict", node: target.id, round: rounds, ok: verdict.ok, issues: verdict.issues });
			if (verdict.ok) {
				accepted = nodes;
				const warns = verdict.issues.filter(i => i.severity === "warn").map(i => `${i.node}: ${i.message}`);
				return `Accepted.${warns.length ? `\nWarnings (no action needed):\n- ${warns.join("\n- ")}` : ""} You are done.`;
			}
			const list = verdict.issues
				.filter(i => i.severity === "reject")
				.map(i => `[${i.rule}] ${i.node}: ${i.message}`)
				.join("\n- ");
			return rounds >= MAX_ROUNDS
				? `Rejected and out of rounds; the subtree will be kept with failing parts downgraded. Stop.\n- ${list}`
				: `Rejected (round ${rounds}/${MAX_ROUNDS}). Fix and resubmit:\n- ${list}`;
		},
	};

	const roots = target.cites.map(c => `${c.symbol} (${c.file}:${c.start}-${c.end})`).join("\n");
	const prompt = `Step: ${target.title}\n${target.blurb}\n\nRoot symbols:\n${roots}\n\nExplore from these with the graph tools, then call submit_node with the subtree.`;
	await runner.run({
		role: "author",
		system: AUTHOR_SYSTEM,
		prompt,
		tools: [...graphTools(index, opts.log), submit],
		isDone: () => accepted !== undefined || rounds >= MAX_ROUNDS,
		signal: opts.signal,
	});

	if (accepted) return { nodes: accepted, rounds, accepted: true };
	if (last) return { nodes: salvageSubtree(index, last, target.parentCites), rounds, accepted: false };
	// No submission at all: keep the step as a flagged leaf anchored to its roots.
	const fallback: BlueprintNode = {
		id: target.id,
		parent: target.parent,
		title: target.title,
		blurb: target.blurb,
		children: [],
		arrows: [],
		cites: target.cites,
		inferred: true,
		needsReview: true,
	};
	return { nodes: [fallback], rounds, accepted: false };
}

const SUBMIT_TREE_DOC = `JSON object for the step: {"title", "blurb", "cites": [{"symbol", "file", "start", "end"}], "children": [ same shape, each with a short "id" ], "arrows": [{"from": childId, "to": childId, "label", "proven": true|false}]}. Children nest recursively; leaves have no children.`;

const AUTHOR_SYSTEM = `You explain one step of a program as a small diagram of parts, drilled down to cited code. You see the code only through the graph tools.

Rules the checker enforces (a violation rejects the submission):
- C1 Every citation names a graph symbol id, with the symbol's file, and a line range inside that symbol's range.
- C2 An arrow with "proven": true must follow call/import edges (at most 2 hops) from a symbol cited by the source child to one cited by the target child. Arrows connect siblings by child id.
- C3 If you cannot prove an arrow, set "proven": false; it will be drawn dashed.
- C4 A child cites only symbols in its parent's scope: the parent's cited symbols and what they contain or call.
- C5 An inner node has 3 to 9 children; titles are at most four words; blurbs are one sentence of at most 25 words.
- C6 A leaf cites at least one range of 60 lines or fewer (cite a sub-range of a large symbol if needed).
- C7 (warning) Avoid citing the same symbol from two siblings.

Order children in the order their work happens. Prefer 2-3 levels. Write plain, concrete blurbs.
Submit with submit_node. On rejection, fix exactly the listed problems and resubmit.`;

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}
