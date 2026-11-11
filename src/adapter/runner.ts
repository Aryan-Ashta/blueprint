/**
 * OMP-backed AgentRunner (spec §11, "How does the generator run author agents
 * without giving them file access?"): each run is a session from
 * `pi.pi.createAgentSession` restricted to exactly the supplied tools, so
 * "authors only see the graph" is enforced by OMP, not by the prompt.
 */

import type { Api, Model as AiModel } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AskEvent } from "../ask";
import type { AgentRunner, ModelRole, RunRequest, RunnerTool } from "../generator";
import type { BlueprintConfig } from "../types";

type Model = AiModel<Api>;

/** Resolved model per role, with the spec's `@tiny` → `@smol` fallback. */
export interface RoleModels {
	overview?: Model;
	author?: Model;
	summary?: Model;
	/** Ask answers: the configured model, else the session's own model ("the agent"). */
	ask?: Model;
}

export function resolveRoleModels(ctx: ExtensionContext, config: BlueprintConfig): RoleModels {
	const resolve = (spec: string) => ctx.models.resolve(spec);
	const fallback = ctx.models.current();
	return {
		overview: resolve(config.overviewModel) ?? fallback,
		author: resolve(config.authorModel) ?? fallback,
		summary: resolve(config.summaryModel) ?? (config.summaryModel === "@tiny" ? resolve("@smol") : undefined) ?? fallback,
		ask: (config.askModel ? resolve(config.askModel) : undefined) ?? fallback,
	};
}

export const modelLabel = (m: Model | undefined) => (m ? `${m.provider}/${m.id}` : "none");

/** How many times a session that has not delivered is reminded before giving up. */
const MAX_NUDGES = 2;

/**
 * A session limited to exactly `tools`: no files, shell, MCP, extensions or
 * LSP. OMP enforces the restriction, not the prompt.
 */
async function openRestrictedSession(pi: ExtensionAPI, ctx: ExtensionContext, model: Model, system: string, tools: RunnerTool[]) {
	const z = pi.zod;
	const sdk = pi.pi;
	const toDefinition = (tool: RunnerTool) => ({
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: z.object(Object.fromEntries(Object.entries(tool.params).map(([k, d]) => [k, z.string().describe(d)]))),
		async execute(_toolCallId: string, params: Record<string, string>) {
			let text: string;
			try {
				text = await tool.execute(params);
			} catch (err) {
				// Errors go back to the model as the tool result so it repairs its own work.
				text = `Error: ${(err as Error).message}`;
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
	const { session } = await sdk.createAgentSession({
		cwd: ctx.cwd,
		model,
		authStorage: ctx.modelRegistry.authStorage,
		modelRegistry: ctx.modelRegistry,
		sessionManager: sdk.SessionManager.inMemory(),
		agentRegistry: new sdk.AgentRegistry(),
		customTools: tools.map(toDefinition),
		toolNames: tools.map(t => t.name),
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		bindProcessState: false,
		taskDepth: 1,
		parentTaskPrefix: "blueprint",
		systemPrompt: [system],
	});
	return session;
}

export function createOmpRunner(pi: ExtensionAPI, ctx: ExtensionContext, models: RoleModels): AgentRunner {
	return {
		async run(req: RunRequest): Promise<void> {
			const model = models[req.role as ModelRole];
			if (!model) throw new Error(`no model available for the ${req.role} role`);
			const session = await openRestrictedSession(pi, ctx, model, req.system, req.tools);
			const onAbort = () => void session.abort().catch(() => {});
			req.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await session.prompt(req.prompt);
				await session.waitForIdle();
				const submitTool = req.tools[req.tools.length - 1]?.name;
				for (let i = 0; i < MAX_NUDGES && !req.isDone() && !req.signal?.aborted; i++) {
					await session.prompt(`You have not finished. Call ${submitTool} now with your result.`);
					await session.waitForIdle();
				}
			} finally {
				req.signal?.removeEventListener("abort", onAbort);
				await session.dispose().catch(() => {});
			}
		},
	};
}

const TOOL_STATUS: Record<string, (args: Record<string, unknown>) => string> = {
	bp_lookup: a => `Searching the blueprint for “${a.query}”`,
	bp_context: a => `Reading ${a.id}`,
	graph_symbol: a => `Inspecting ${String(a.id).split("#").pop()}`,
	graph_callers: a => `Finding callers of ${String(a.id).split("#").pop()}`,
	graph_callees: a => `Finding calls from ${String(a.id).split("#").pop()}`,
	graph_search: a => `Searching symbols for “${a.query}”`,
};

/**
 * Answer one question in a restricted session, streaming progress: tool
 * activity as status lines, and the text of the latest assistant message
 * (earlier messages are preambles to tool calls, so each new one resets).
 */
export async function runAsk(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: Model,
	req: { system: string; prompt: string; tools: RunnerTool[]; signal: AbortSignal },
	emit: (event: AskEvent) => void,
): Promise<void> {
	const session = await openRestrictedSession(pi, ctx, model, req.system, req.tools);
	const onAbort = () => void session.abort().catch(() => {});
	req.signal.addEventListener("abort", onAbort, { once: true });
	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_start" && event.message.role === "assistant") emit({ kind: "reset" });
		else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			emit({ kind: "delta", text: event.assistantMessageEvent.delta });
		} else if (event.type === "tool_execution_start") {
			const args = typeof event.args === "object" && event.args !== null ? (event.args as Record<string, unknown>) : {};
			emit({ kind: "status", text: TOOL_STATUS[event.toolName]?.(args) ?? event.toolName });
		}
	});
	try {
		await session.prompt(req.prompt);
		await session.waitForIdle();
	} finally {
		unsubscribe();
		req.signal.removeEventListener("abort", onAbort);
		await session.dispose().catch(() => {});
	}
}
