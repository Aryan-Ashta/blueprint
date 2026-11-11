/**
 * Build and incremental update orchestration (spec §5 and §7).
 */

import { basename } from "node:path";
import { FileLines, hashAll, markStale, reprefix, replaceSubtree, staleRoots, subtreeIds } from "./blueprint";
import { checkNode } from "./checker";
import {
	type AgentRunner,
	type OverviewStep,
	authorSubtree,
	checkSubtree,
	mapLimit,
	summarizeSymbols,
	writeOverview,
} from "./generator";
import { GraphIndex } from "./graph";
import { indexProject } from "./indexer";
import type { LspRegistry } from "./lsp";
import type { Store } from "./store";
import type { Arrow, Blueprint, BlueprintConfig, BlueprintMeta, BlueprintNode, Citation, FactGraph } from "./types";
import { PLUGIN_VERSION } from "./types";

export type BlueprintEvent = "changed" | "stale" | "rebuilt";

export interface PipelineDeps {
	root: string;
	store: Store;
	registry: LspRegistry;
	runner: AgentRunner;
	config: BlueprintConfig;
	/** Model ids actually used per role, recorded in meta.json. */
	modelsUsed?: BlueprintMeta["modelsUsed"];
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
	emit?: (event: BlueprintEvent, data: unknown) => void;
}

export interface BuildReport {
	steps: number;
	nodes: number;
	needsReview: string[];
	symbols: number;
	edges: number;
	truncated: boolean;
	servers: string[];
}

export interface UpdateReport {
	reindexed: number;
	stale: string[];
	reauthored: string[];
	reoverview: boolean;
}

const AUTHOR_CONCURRENCY = 4;
const ROOT = "root";

function gitHead(root: string): string | undefined {
	const p = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
}

/** A citation of a whole symbol. */
function citeSymbol(index: GraphIndex, id: string): Citation | null {
	const s = index.symbol(id);
	return s ? { symbol: s.id, file: s.range.file, start: s.range.start, end: s.range.end } : null;
}

/** Arrows between consecutive top-level steps; proven only when the graph backs them. */
function stepArrows(index: GraphIndex, bp: Blueprint, stepIds: string[]): Arrow[] {
	const root = bp.nodes[ROOT];
	// Unlabelled: execution order is already the layout's left-to-right reading order.
	const candidate: Arrow[] = stepIds.slice(1).map((to, i) => ({ from: stepIds[i], to, proven: true }));
	const probe = { ...root, arrows: candidate };
	const { provenArrows } = checkNode(index, probe, stepIds.map(id => bp.nodes[id]).filter(Boolean));
	return candidate.map((a, i) => ({ ...a, proven: provenArrows[i] === true }));
}

async function indexAndLoad(deps: PipelineDeps, previous: FactGraph | undefined, buildId: string) {
	const result = await indexProject(deps.root, deps.registry, {
		scope: deps.config.scope,
		maxSymbols: deps.config.maxSymbols,
		previous,
		onProgress: deps.onProgress,
	});
	await deps.store.logRun(buildId, {
		type: "index",
		indexed: result.indexed,
		skipped: result.skipped,
		symbols: result.graph.symbols.length,
		edges: result.graph.edges.length,
		servers: result.serversUsed,
		truncated: result.truncated,
	});
	return result;
}

// ---------------------------------------------------------------------------
// Full build
// ---------------------------------------------------------------------------

export async function build(deps: PipelineDeps): Promise<BuildReport> {
	const { store, runner, signal } = deps;
	const buildId = `build-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
	const log = (entry: Record<string, unknown>) => void store.logRun(buildId, entry);
	await store.ensure();

	deps.onProgress?.("indexing with language servers…");
	const indexed = await indexAndLoad(deps, undefined, buildId);
	if (indexed.graph.symbols.length === 0) {
		const lsp = await deps.registry.describe();
		throw new Error(
			`no symbols indexed (LSP via ${lsp.source === "omp" ? "OMP's client" : "own client"}; servers: ${lsp.servers.join(", ") || "none detected"})` +
				(indexed.errors.length ? `:\n- ${indexed.errors.join("\n- ")}` : ""),
		);
	}
	const index = new GraphIndex(indexed.graph);

	if (deps.config.summarize) {
		deps.onProgress?.("summarizing symbols…");
		try {
			await summarizeSymbols(index, runner, { signal, log });
		} catch (err) {
			log({ type: "summaries_failed", error: (err as Error).message });
		}
	}
	await store.writeGraph(indexed.graph);

	deps.onProgress?.("writing overview…");
	const steps = await writeOverview(index, runner, { signal, log });

	const bp = emptyBlueprint(deps.root);
	const stepRoots: Record<string, string[]> = {};
	const targets = steps.map((step, i) => {
		const id = `s${i + 1}`;
		stepRoots[id] = step.rootSymbols;
		return {
			id,
			parent: ROOT,
			title: step.title,
			blurb: step.blurb,
			cites: step.rootSymbols.map(s => citeSymbol(index, s)).filter((c): c is Citation => !!c),
		};
	});

	let done = 0;
	const results = await mapLimit(targets, AUTHOR_CONCURRENCY, async target => {
		const r = await authorSubtree(index, runner, target, { signal, log });
		deps.onProgress?.(`authored ${++done}/${targets.length}: ${target.title}${r.accepted ? "" : " (needs review)"}`);
		return r;
	});
	for (const r of results) for (const n of r.nodes) bp.nodes[n.id] = n;
	bp.nodes[ROOT].children = targets.map(t => t.id);
	bp.steps = bp.nodes[ROOT].children;
	bp.nodes[ROOT].arrows = stepArrows(index, bp, bp.steps);

	await hashAll(bp, index, new FileLines(deps.root));
	await store.writeBlueprint(bp);
	await store.writeMeta({
		commit: gitHead(deps.root),
		pluginVersion: PLUGIN_VERSION,
		modelsUsed: deps.modelsUsed,
		builtAt: new Date().toISOString(),
		entryPoints: index.entryPoints().map(s => s.id),
		stepRoots,
	});
	await store.clearChanges();
	deps.emit?.("rebuilt", { nodes: Object.keys(bp.nodes).length });

	const needsReview = Object.values(bp.nodes).filter(n => n.needsReview).map(n => n.id);
	return {
		steps: targets.length,
		nodes: Object.keys(bp.nodes).length,
		needsReview,
		symbols: indexed.graph.symbols.length,
		edges: indexed.graph.edges.length,
		truncated: indexed.truncated,
		servers: indexed.serversUsed,
	};
}

function emptyBlueprint(root: string): Blueprint {
	return {
		version: 1,
		root: ROOT,
		nodes: {
			[ROOT]: { id: ROOT, title: basename(root), blurb: "", children: [], arrows: [], cites: [] },
		},
		steps: [],
	};
}

// ---------------------------------------------------------------------------
// Staleness only (agent_end without auto-update)
// ---------------------------------------------------------------------------

export async function refreshStaleness(root: string, store: Store): Promise<string[]> {
	const [bp, graph] = await Promise.all([store.readBlueprint(), store.readGraph()]);
	if (!bp || !graph) return [];
	const { stale, moved } = await markStale(bp, new GraphIndex(graph), new FileLines(root));
	if (stale.length > 0 || moved) await store.writeBlueprint(bp);
	return stale;
}

// ---------------------------------------------------------------------------
// Incremental update (spec §7)
// ---------------------------------------------------------------------------

export async function update(deps: PipelineDeps): Promise<UpdateReport> {
	const { store, runner, signal } = deps;
	const [bp, previous, meta] = await Promise.all([store.readBlueprint(), store.readGraph(), store.readMeta()]);
	if (!bp || !previous) throw new Error("no blueprint yet: run /blueprint build first");
	const buildId = `update-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
	const log = (entry: Record<string, unknown>) => void store.logRun(buildId, entry);

	// 1–2. Re-index only files whose content hash changed.
	deps.onProgress?.("re-indexing changed files…");
	const indexed = await indexAndLoad(deps, previous, buildId);
	const index = new GraphIndex(indexed.graph);
	const files = new FileLines(deps.root);

	// 3. Recompute hashes; changed → stale.
	const stale = new Set((await markStale(bp, index, files)).stale);
	for (const n of Object.values(bp.nodes)) if (n.stale) stale.add(n.id);

	// 5. Re-run the overview if a step's root symbols vanished or a new entry point appeared.
	const stepIds = bp.nodes[ROOT].children;
	const stepRoots = meta?.stepRoots ?? {};
	const brokenSteps = stepIds.filter(id => (stepRoots[id] ?? []).some(sym => !index.symbol(sym)));
	const knownEntries = new Set(meta?.entryPoints ?? []);
	const entryPoints = index.entryPoints().map(s => s.id);
	const newEntry = entryPoints.some(id => !knownEntries.has(id));
	const reauthored: string[] = [];
	let reoverview = false;
	let newStepRoots = stepRoots;

	if (brokenSteps.length > 0 || newEntry) {
		reoverview = true;
		deps.onProgress?.("re-running overview…");
		const keep: OverviewStep[] = stepIds
			.filter(id => !brokenSteps.includes(id))
			.map(id => ({ title: bp.nodes[id].title, blurb: bp.nodes[id].blurb, rootSymbols: stepRoots[id] ?? [] }));
		const steps = await writeOverview(index, runner, { keep, signal, log });
		const oldByKey = new Map(stepIds.map(id => [stepKey(bp.nodes[id].title, stepRoots[id] ?? []), id]));
		const nextNodes: Record<string, BlueprintNode> = { [ROOT]: bp.nodes[ROOT] };
		newStepRoots = {};
		const toAuthor: { id: string; title: string; blurb: string; cites: Citation[]; parent: string }[] = [];
		steps.forEach((step, i) => {
			const id = `s${i + 1}`;
			newStepRoots[id] = step.rootSymbols;
			const oldId = oldByKey.get(stepKey(step.title, step.rootSymbols));
			if (oldId && !stale.has(oldId)) {
				for (const n of reprefix(subtreeIds(bp, oldId).map(x => bp.nodes[x]), oldId, id)) nextNodes[n.id] = n;
			} else {
				toAuthor.push({
					id,
					parent: ROOT,
					title: step.title,
					blurb: step.blurb,
					cites: step.rootSymbols.map(s => citeSymbol(index, s)).filter((c): c is Citation => !!c),
				});
			}
		});
		bp.nodes = nextNodes;
		bp.nodes[ROOT].children = steps.map((_, i) => `s${i + 1}`);
		const results = await mapLimit(toAuthor, AUTHOR_CONCURRENCY, t => authorSubtree(index, runner, t, { signal, log }));
		for (const r of results) for (const n of r.nodes) bp.nodes[n.id] = n;
		reauthored.push(...toAuthor.map(t => t.id));
	} else {
		// 4. Re-author the minimal stale subtrees; re-check their parents.
		const roots = staleRoots(bp, stale).filter(id => id !== ROOT && bp.nodes[id]);
		const queue = [...roots];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const id = queue.shift()!;
			if (seen.has(id) || !bp.nodes[id]) continue;
			seen.add(id);
			const node = bp.nodes[id];
			const parent = node.parent ? bp.nodes[node.parent] : undefined;
			const validCites = node.cites.filter(c => !!index.symbol(c.symbol));
			deps.onProgress?.(`re-authoring ${id}: ${node.title}`);
			const r = await authorSubtree(
				index,
				runner,
				{
					id,
					parent: node.parent,
					title: node.title,
					blurb: node.blurb,
					cites: validCites.length > 0 ? validCites : (parent?.cites ?? []),
					parentCites: parent && parent.id !== ROOT ? parent.cites : undefined,
				},
				{ signal, log },
			);
			replaceSubtree(bp, id, r.nodes);
			reauthored.push(id);
			// Parent is re-checked; rewritten only if it now fails a rule.
			if (parent && parent.id !== ROOT) {
				const parentNodes = subtreeIds(bp, parent.id).map(x => bp.nodes[x]);
				const grand = parent.parent ? bp.nodes[parent.parent] : undefined;
				const verdict = checkSubtree(index, parentNodes, grand && grand.id !== ROOT ? grand.cites : undefined);
				const parentIssues = verdict.issues.filter(i => i.node === parent.id && i.severity === "reject");
				log({ type: "parent_recheck", node: parent.id, ok: parentIssues.length === 0, issues: parentIssues });
				if (parentIssues.length > 0) queue.push(parent.id);
			}
		}
	}

	bp.steps = bp.nodes[ROOT].children;
	bp.nodes[ROOT].arrows = stepArrows(index, bp, bp.steps);
	for (const n of Object.values(bp.nodes)) n.stale = undefined;
	await hashAll(bp, index, files);
	await store.writeGraph(indexed.graph);
	await store.writeBlueprint(bp);
	await store.writeMeta({
		...(meta ?? { pluginVersion: PLUGIN_VERSION }),
		commit: gitHead(deps.root),
		pluginVersion: PLUGIN_VERSION,
		builtAt: new Date().toISOString(),
		entryPoints,
		stepRoots: newStepRoots,
	});
	await store.clearChanges();
	deps.emit?.("rebuilt", { reauthored });
	return { reindexed: indexed.indexed, stale: [...stale], reauthored, reoverview };
}

function stepKey(title: string, roots: string[]): string {
	return `${title.toLowerCase()}|${[...roots].sort().join(",")}`;
}
