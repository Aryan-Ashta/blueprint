/**
 * omp-blueprint — OMP adapter (spec §8). The only module (with ./adapter/)
 * that touches OMP's extension API, so API churn stays contained here.
 *
 * Registers, during load: the `/blueprint` command, the `bp_lookup` and
 * `bp_context` tools, the `blueprint` message renderer, and the
 * session_start / before_agent_start / tool_result / agent_end hooks.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { createOmpRunner, modelLabel, resolveRoleModels, runAsk } from "./adapter/runner";
import { ASK_SYSTEM, askPrompt, askTools } from "./ask";
import {
	type ChangedRange,
	describeNodeLine,
	FileLines,
	findNodes,
	nodeContext,
	nodesForRange,
	workingTreeRanges,
} from "./blueprint";
import { GraphIndex } from "./graph";
import { build, refreshStaleness, update } from "./pipeline";
import { LspRegistry } from "./lsp";
import { parseRangeTarget, Store } from "./store";
import type { Blueprint, Pick } from "./types";
import { type AskHandler, ViewerServer } from "./viewer/server";

/** Tools that change files (spec §11): `git diff` decides what they changed. */
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true, bash: true };
const SUBCOMMANDS = [
	{ value: "build", label: "build", description: "Index the repo and generate the blueprint" },
	{ value: "update", label: "update", description: "Re-index changed files and re-author stale parts" },
	{ value: "open", label: "open", description: "Open the blueprint viewer in the browser" },
	{ value: "status", label: "status", description: "Show blueprint, viewer and LSP status" },
];

/**
 * Per-project runtime state. Module globals are shared by parent and child
 * sessions (spec: subagents never start a second server), so keyed by cwd.
 */
interface ProjectState {
	store: Store;
	viewer?: ViewerServer;
	busy?: string;
	abort?: AbortController;
	/** `git diff` ranges already attributed, so each edit marks only what it changed. */
	seenRanges: Set<string>;
}
const projects = new Map<string, ProjectState>();

function project(cwd: string): ProjectState {
	let p = projects.get(cwd);
	if (!p) {
		p = { store: new Store(cwd), seenRanges: new Set(workingTreeRanges(cwd).map(rangeKey)) };
		projects.set(cwd, p);
	}
	return p;
}

const rangeKey = (r: ChangedRange) => `${r.file}:${r.start}-${r.end}`;

/** Start the viewer once per project; every call refreshes the Ask handler with the caller's live context. */
function ensureViewer(p: ProjectState, cwd: string, editorCommand: string | undefined, ask: AskHandler): ViewerServer {
	if (!p.viewer) {
		p.viewer = new ViewerServer({ root: cwd, store: p.store, editorCommand });
		p.viewer.start();
	}
	p.viewer.setAskHandler(ask);
	return p.viewer;
}

function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	try {
		Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
	} catch {
		// no opener: the URL is still shown to the user
	}
}

/** Render picks as context the model can act on: cited code for nodes and ranges. */
async function picksMessage(bp: Blueprint | null, picks: Pick[], cwd: string, store: Store): Promise<string> {
	const files = new FileLines(cwd);
	const parts: string[] = [`The user selected ${picks.length} item(s) in the blueprint viewer as context for this request.`];
	for (const pick of picks) {
		const note = pick.note ? `\nUser note: ${pick.note}` : "";
		if (pick.kind === "node" && bp) {
			parts.push(`## Blueprint node${note}\n${await nodeContext(bp, pick.target, files, 120)}`);
		} else if (pick.kind === "arrow" && bp) {
			const [from, to] = pick.target.split("->");
			const a = bp.nodes[from];
			const b = bp.nodes[to];
			const arrow = a?.parent ? bp.nodes[a.parent]?.arrows.find(x => x.from === from && x.to === to) : undefined;
			parts.push(
				`## Blueprint arrow: ${a?.title ?? from} → ${b?.title ?? to} ${arrow?.proven ? "[proven by call graph]" : "[inferred]"}${note}\n` +
					`From cites: ${a?.cites.map(c => `${c.file}:${c.start}-${c.end}`).join(", ") || "-"}\n` +
					`To cites: ${b?.cites.map(c => `${c.file}:${c.start}-${c.end}`).join(", ") || "-"}`,
			);
		} else if (pick.kind === "range") {
			// Re-checked here, not only in the viewer: whatever is in picks.jsonl, only indexed files reach the model.
			const range = parseRangeTarget(pick.target);
			const file = range && (await store.indexedFile(range.file));
			const lines = range && file ? await files.slice(file, range.start, Math.min(range.end, range.start + 150)) : null;
			parts.push(`## Code range ${pick.target}${note}\n\`\`\`\n${lines?.join("\n") ?? "<unavailable: not a file in the blueprint>"}\n\`\`\``);
		}
	}
	return parts.join("\n\n");
}

export default function blueprint(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.setLabel("Blueprint");

	// ---- Ask (viewer → restricted answering session) ---------------------------

	/** Answers viewer questions in a session restricted to the blueprint and graph tools. */
	function askHandler(ctx: ExtensionContext): AskHandler {
		return async (req, emit, signal) => {
			const p = project(ctx.cwd);
			const [bp, graph, config] = await Promise.all([p.store.readBlueprint(), p.store.readGraph(), p.store.readConfig()]);
			if (!bp) throw new Error("No blueprint yet — run /blueprint build.");
			const model = resolveRoleModels(ctx, config).ask;
			if (!model) throw new Error("No model available — pick one in omp first.");
			const files = new FileLines(ctx.cwd);
			emit({ kind: "status", text: `Asking ${model.name || model.id}` });
			await runAsk(
				pi,
				ctx,
				model,
				{ system: ASK_SYSTEM, prompt: await askPrompt(bp, req, files), tools: askTools(bp, graph ? new GraphIndex(graph) : null, files), signal },
				emit,
			);
		};
	}

	// ---- background work -----------------------------------------------------

	async function runJob(ctx: ExtensionContext, kind: "build" | "update"): Promise<void> {
		const p = project(ctx.cwd);
		if (p.busy) {
			ctx.ui.notify(`blueprint: ${p.busy} already running`, "warning");
			return;
		}
		const config = await p.store.readConfig();
		const models = resolveRoleModels(ctx, config);
		if (kind === "build" && ctx.hasUI) {
			// Privacy (spec §14): show which providers receive code before starting.
			const providers = [...new Set([models.overview, models.author, config.summarize ? models.summary : undefined].filter(Boolean).map(m => m!.provider))];
			const ok = await ctx.ui.confirm(
				"Build blueprint?",
				`Code summaries and graph excerpts will be sent to: ${providers.join(", ") || "(no models resolved)"}\n` +
					`overview ${modelLabel(models.overview)} · authors ${modelLabel(models.author)}${config.summarize ? ` · summaries ${modelLabel(models.summary)}` : ""}`,
			);
			if (!ok) return;
		}
		p.busy = kind;
		p.abort = new AbortController();
		const registry = new LspRegistry(ctx.cwd);
		const viewer = p.viewer;
		const deps = {
			root: ctx.cwd,
			store: p.store,
			registry,
			runner: createOmpRunner(pi, ctx, models),
			config,
			modelsUsed: { overview: modelLabel(models.overview), authors: modelLabel(models.author), summaries: modelLabel(models.summary) },
			signal: p.abort.signal,
			onProgress: (msg: string) => ctx.ui.setStatus("blueprint", `blueprint: ${msg}`),
			emit: (event: "changed" | "stale" | "rebuilt", data: unknown) => (p.viewer ?? viewer)?.notify(event, data),
		};
		try {
			if (kind === "build") {
				const r = await build(deps);
				p.seenRanges = new Set(workingTreeRanges(ctx.cwd).map(rangeKey));
				ctx.ui.notify(
					`blueprint built: ${r.steps} steps, ${r.nodes} nodes from ${r.symbols} symbols / ${r.edges} edges (${r.servers.join(", ") || "no LSP"})` +
						`${r.needsReview.length ? `; ${r.needsReview.length} flagged for review` : ""}${r.truncated ? `; symbol cap ${config.maxSymbols} reached — set "scope" in .blueprint/config.json` : ""}`,
					r.needsReview.length ? "warning" : "info",
				);
				if (config.openAfterBuild) openInBrowser(ensureViewer(p, ctx.cwd, config.editorCommand, askHandler(ctx)).url!);
				else ensureViewer(p, ctx.cwd, config.editorCommand, askHandler(ctx));
			} else {
				const r = await update(deps);
				p.seenRanges = new Set(workingTreeRanges(ctx.cwd).map(rangeKey));
				ctx.ui.notify(
					`blueprint updated: ${r.reindexed} files re-indexed, ${r.reauthored.length} subtrees re-authored${r.reoverview ? " (overview re-run)" : ""}`,
					"info",
				);
			}
		} catch (err) {
			ctx.ui.notify(`blueprint ${kind} failed: ${(err as Error).message}`, "error");
		} finally {
			ctx.ui.setStatus("blueprint", undefined);
			p.busy = undefined;
			p.abort = undefined;
			await registry.dispose();
		}
	}

	// ---- /blueprint ----------------------------------------------------------

	pi.registerCommand("blueprint", {
		description: "Drill-down blueprint of this repository: build | update | open | status",
		getArgumentCompletions: prefix => {
			const items = SUBCOMMANDS.filter(s => s.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "open";
			const p = project(ctx.cwd);
			const config = await p.store.readConfig();
			switch (sub) {
				case "build":
				case "update": {
					if (sub === "update" && !(await p.store.exists())) {
						ctx.ui.notify("blueprint: nothing to update yet — run /blueprint build", "warning");
						return;
					}
					// Long-running: continue in the background so the session stays usable.
					void runJob(ctx, sub).catch(err => ctx.ui.notify(`blueprint: ${(err as Error).message}`, "error"));
					return;
				}
				case "open": {
					const url = ensureViewer(p, ctx.cwd, config.editorCommand, askHandler(ctx)).url!;
					openInBrowser(url);
					ctx.ui.notify(`blueprint viewer: ${url}`, "info");
					return;
				}
				case "status": {
					const [bp, meta] = await Promise.all([p.store.readBlueprint(), p.store.readMeta()]);
					const lsp = await new LspRegistry(ctx.cwd).describe();
					const nodes = bp ? Object.values(bp.nodes) : [];
					ctx.ui.notify(
						[
							bp ? `blueprint: ${bp.nodes[bp.root].children.length} steps, ${nodes.length} nodes, ${nodes.filter(n => n.stale).length} stale, ${nodes.filter(n => n.needsReview).length} need review` : "blueprint: none (run /blueprint build)",
							meta ? `built ${meta.builtAt ?? "?"} at ${meta.commit?.slice(0, 8) ?? "?"} with ${JSON.stringify(meta.modelsUsed ?? {})}` : "",
							`viewer: ${p.viewer?.url ?? "not running"}`,
							`lsp (${lsp.source === "omp" ? "OMP client" : "own client"}): ${lsp.servers.join(", ") || "none detected"}`,
							p.busy ? `running: ${p.busy}` : "",
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
					return;
				}
				case "cancel": {
					p.abort?.abort();
					ctx.ui.notify(p.busy ? `blueprint: cancelling ${p.busy}` : "blueprint: nothing running", "info");
					return;
				}
				default:
					ctx.ui.notify(`blueprint: unknown subcommand "${sub}" (build | update | open | status | cancel)`, "warning");
			}
		},
	});

	// ---- tools ---------------------------------------------------------------

	pi.registerTool({
		name: "bp_lookup",
		label: "Blueprint Lookup",
		description:
			"Find nodes in this repository's blueprint (a checked map of the program's steps and parts, with cited code) by text, title, file path or symbol id. Returns node ids for bp_context.",
		parameters: z.object({ query: z.string().describe("Text, file path, or symbol id (file#name)") }),
		approval: "read",
		async execute(_id, params: { query: string }, _signal, _onUpdate, ctx) {
			const bp = await project(ctx.cwd).store.readBlueprint();
			if (!bp) return { content: [{ type: "text", text: "No blueprint for this repository. The user can run /blueprint build." }], details: { count: 0 } };
			const hits = findNodes(bp, params.query);
			return {
				content: [{ type: "text", text: hits.length ? hits.map(n => describeNodeLine(bp, n)).join("\n") : `No blueprint nodes match "${params.query}".` }],
				details: { count: hits.length },
			};
		},
	});

	pi.registerTool({
		name: "bp_context",
		label: "Blueprint Context",
		description: "Get a blueprint node's title, blurb, parts, arrows (proven vs inferred) and cited code.",
		parameters: z.object({ id: z.string().describe("Node id from bp_lookup, e.g. s2.3") }),
		approval: "read",
		async execute(_id, params: { id: string }, _signal, _onUpdate, ctx) {
			const bp = await project(ctx.cwd).store.readBlueprint();
			if (!bp) return { content: [{ type: "text", text: "No blueprint for this repository." }], details: {} };
			return { content: [{ type: "text", text: await nodeContext(bp, params.id, new FileLines(ctx.cwd)) }], details: {} };
		},
	});

	// ---- picks chip ------------------------------------------------------------

	pi.registerMessageRenderer<{ picks: Pick[] }>("blueprint", (message, { expanded }, theme) => {
		const picks = message.details?.picks ?? [];
		const summary = picks.map(p => (p.kind === "range" ? p.target : p.kind === "arrow" ? `arrow ${p.target}` : p.target)).join(", ");
		const content = typeof message.content === "string" ? message.content : "";
		return {
			render(width: number) {
				const head = truncateToWidth(`${theme.fg("accent", "◆ blueprint")} ${theme.fg("muted", `${picks.length} pick${picks.length === 1 ? "" : "s"}: ${summary}`)}`, width);
				return expanded ? [head, ...content.split("\n").map(l => truncateToWidth(l, width))] : [head];
			},
			isTranscriptBlockCompact: () => !expanded,
		};
	});

	// ---- hooks -----------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		const p = project(ctx.cwd);
		if (!(await p.store.exists())) return;
		const config = await p.store.readConfig();
		const viewer = ensureViewer(p, ctx.cwd, config.editorCommand, askHandler(ctx));
		ctx.ui.setStatus("blueprint-url", `blueprint: ${viewer.url}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "sub" || event.reason === "revive") return;
		const p = project(ctx.cwd);
		p.viewer?.setAskHandler(askHandler(ctx));
		const picks = await p.store.drainPicks();
		if (picks.length === 0) return;
		const bp = await p.store.readBlueprint();
		return {
			message: {
				customType: "blueprint",
				content: await picksMessage(bp, picks, ctx.cwd, p.store),
				display: true,
				details: { picks },
			},
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.isError || !EDIT_TOOLS[event.toolName]) return;
		const p = project(ctx.cwd);
		const bp = await p.store.readBlueprint();
		if (!bp) return;
		// Ranges from git diff, so new edit tools are covered without parsing their input.
		const fresh = workingTreeRanges(ctx.cwd).filter(r => !p.seenRanges.has(rangeKey(r)));
		if (fresh.length === 0) return;
		const touched = new Set<string>();
		for (const r of fresh) {
			p.seenRanges.add(rangeKey(r));
			const nodes = nodesForRange(bp, r);
			if (nodes.length === 0) continue;
			for (const n of nodes) touched.add(n);
			await p.store.appendChange({ timestamp: new Date().toISOString(), tool: event.toolName, file: r.file, start: r.start, end: r.end, nodes });
		}
		if (touched.size > 0) p.viewer?.notify("changed", { nodes: [...touched] });
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const p = project(ctx.cwd);
		if (!(await p.store.exists()) || p.busy) return;
		const stale = await refreshStaleness(ctx.cwd, p.store);
		if (stale.length > 0) p.viewer?.notify("stale", { nodes: stale });
		const config = await p.store.readConfig();
		if (config.autoUpdate && stale.length > 0) {
			void runJob(ctx, "update").catch(err => ctx.ui.notify(`blueprint: ${(err as Error).message}`, "error"));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		const p = projects.get(ctx.cwd);
		p?.abort?.abort();
		p?.viewer?.stop();
		if (p) p.viewer = undefined;
	});
}
