/**
 * Ask: answer a user's question about the codebase from the blueprint.
 *
 * The answering agent sees the blueprint (bp_lookup / bp_context) and the fact
 * graph (graph_* tools), never raw files, so answers stay grounded in checked
 * nodes and cited code. It refers to parts as [[node-id]], which the viewer
 * turns into links. Model sessions are reached only through the adapter.
 */

import { describeNodeLine, FileLines, findNodes, nodeContext, nodePath } from "./blueprint";
import { graphTools, type RunnerTool } from "./generator";
import type { GraphIndex } from "./graph";
import type { Blueprint } from "./types";

export interface AskRequest {
	question: string;
	/** Node the question is about (from "Ask about this…"), if any. */
	node?: string;
}

/** Streamed to the viewer as SSE `answer` events, keyed by ask id. */
export type AskEvent =
	| { kind: "status"; text: string }
	| { kind: "reset" }
	| { kind: "delta"; text: string }
	| { kind: "done" }
	| { kind: "error"; text: string };

export function askTools(bp: Blueprint, index: GraphIndex | null, files: FileLines): RunnerTool[] {
	const tools: RunnerTool[] = [
		{
			name: "bp_lookup",
			description: "Find blueprint nodes by text, title, file path or symbol id. Returns node ids with their path and blurb.",
			params: { query: "Text, file path, or symbol id (file#name)" },
			execute: async ({ query }) => {
				const hits = findNodes(bp, query ?? "");
				return hits.length ? hits.map(n => describeNodeLine(bp, n)).join("\n") : `No blueprint nodes match "${query}".`;
			},
		},
		{
			name: "bp_context",
			description: "Get a blueprint node's blurb, parts, arrows (proven vs inferred) and cited code.",
			params: { id: "Node id, e.g. s2.3" },
			execute: async ({ id }) => await nodeContext(bp, id ?? "", files),
		},
	];
	return index ? [...tools, ...graphTools(index)] : tools;
}

export const ASK_SYSTEM = `You answer questions about a codebase using its blueprint: a checked map of the program's ordered steps, their parts, and cited code. You see the code only through your tools.

- Use bp_lookup and bp_context to find the relevant parts; use the graph_* tools for calls and callers the blueprint does not show.
- Ground every claim in what the tools return. If the blueprint does not cover something, say so plainly.
- Refer to blueprint parts as [[node-id]] (for example [[s2.3]]) — the reader can click them. Refer to code as \`file:line\`.
- Arrows marked inferred are model judgement, not proven calls; say so when an answer depends on one.
- Be concise: a direct answer first, then the supporting parts. Use short paragraphs or bullet lists; no headings.`;

/** First user message: the question plus the map's top level, and the focused node when given. */
export async function askPrompt(bp: Blueprint, req: AskRequest, files: FileLines): Promise<string> {
	const steps = bp.nodes[bp.root].children
		.map(id => bp.nodes[id])
		.filter(Boolean)
		.map(n => `- [[${n.id}]] ${n.title}: ${n.blurb}`)
		.join("\n");
	const parts = [`Top-level steps of this program:\n${steps}`];
	if (req.node && bp.nodes[req.node]) {
		parts.push(`The question is about [[${req.node}]] (${nodePath(bp, req.node).join(" › ")}):\n${await nodeContext(bp, req.node, files, 120)}`);
	}
	parts.push(`Question: ${req.question}`);
	return parts.join("\n\n");
}
