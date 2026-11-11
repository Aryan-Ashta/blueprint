/**
 * LSP integration.
 *
 * Primary path: reuse OMP's own LSP client through its wildcard subpath
 * exports (`lsp/client`, `lsp/config`), so the plugin rides OMP's running
 * servers and the user's `lsp.json` setup. Fallback: a self-contained JSON-RPC
 * stdio client that launches the same server commands from the same config
 * files and declares the call-hierarchy capability. Every failure of the
 * primary path degrades to the fallback (spec §11 and §14).
 */

import { join } from "node:path";
import { isRecord } from "./util";

// -- LSP wire types (only what we use) --------------------------------------

export interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: DocumentSymbol[];
}

/** Older servers answer documentSymbol with flat SymbolInformation instead. */
interface SymbolInformation {
	name: string;
	kind: number;
	location: { uri: string; range: LspRange };
	containerName?: string;
}

export interface CallHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: LspRange;
	selectionRange: LspRange;
	detail?: string;
	data?: unknown;
}

export interface CallHierarchyOutgoingCall {
	to: CallHierarchyItem;
	fromRanges: LspRange[];
}

// ---------------------------------------------------------------------------
// Server config (shared by primary and fallback paths)
// ---------------------------------------------------------------------------

export interface ServerConfigLike {
	command: string;
	args?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	languageId?: string;
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	isLinter?: boolean;
	resolvedCommand?: string;
}

export interface LspConfigResult {
	/** server name → effective config, enabled and detected for this cwd. */
	servers: Record<string, ServerConfigLike>;
	/** "omp" when OMP's config loader was used, otherwise "self". */
	source: "omp" | "self";
}

/** The subset of OMP's internal LSP API the plugin relies on (undocumented; may change). */
export interface OmpLspBridge {
	getOrCreateClient(config: ServerConfigLike, cwd: string, initTimeoutMs?: number): Promise<unknown>;
	sendRequest(client: unknown, method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
	ensureFileOpen(client: unknown, filePath: string): Promise<void>;
	getConfig(cwd: string): { servers: Record<string, ServerConfigLike> };
}

let ompBridgePromise: Promise<OmpLspBridge | null> | undefined;

/**
 * Import OMP's internal LSP modules. Dynamic import is required: these are
 * undocumented subpaths that may vanish or change shape in a future OMP, and a
 * static import would fail the whole plugin at load. The specifiers must stay
 * string literals: OMP only redirects literal `@oh-my-pi/*` imports to its own
 * embedded copy. The check below confirms the expected functions exist
 * (spec §14); otherwise we fall back.
 */
export function loadOmpBridge(): Promise<OmpLspBridge | null> {
	ompBridgePromise ??= (async () => {
		if (process.env.OMP_BLUEPRINT_LSP === "self") return null;
		try {
			// Shape is verified field by field below, so the module is read as an unknown record.
			const client: Partial<Record<keyof OmpLspBridge, unknown>> = await import("@oh-my-pi/pi-coding-agent/lsp/client");
			const config: Partial<Record<keyof OmpLspBridge, unknown>> = await import("@oh-my-pi/pi-coding-agent/lsp/config");
			if (
				typeof client.getOrCreateClient !== "function" ||
				typeof client.sendRequest !== "function" ||
				typeof client.ensureFileOpen !== "function" ||
				typeof config.getConfig !== "function"
			) {
				return null;
			}
			// Every member was checked to be a function above; their signatures are OMP's (lsp/client.ts, lsp/config.ts @ 18.18.x).
			const bridge = {
				getOrCreateClient: client.getOrCreateClient,
				sendRequest: client.sendRequest,
				ensureFileOpen: client.ensureFileOpen,
				getConfig: config.getConfig,
			} as OmpLspBridge;
			return bridge;
		} catch {
			return null;
		}
	})();
	return ompBridgePromise;
}

/** Effective LSP server config, preferring OMP's own loader. */
export async function loadLspConfig(cwd: string, bridge: OmpLspBridge | null): Promise<LspConfigResult> {
	if (bridge) {
		try {
			const { servers } = bridge.getConfig(cwd);
			if (servers && typeof servers === "object") return { servers, source: "omp" };
		} catch {
			// fall through to self-loading
		}
	}
	return { servers: await loadConfigSelf(cwd), source: "self" };
}

/**
 * Fallback loader: the same config files OMP reads (lowest → highest
 * precedence), filtered to servers whose binary is installed. Without OMP's
 * built-in defaults, only explicitly configured servers are known.
 */
async function loadConfigSelf(cwd: string): Promise<Record<string, ServerConfigLike>> {
	const servers: Record<string, ServerConfigLike> = {};
	const home = process.env.HOME ?? "";
	const userDir = process.env.PI_CONFIG_DIR ?? (home ? join(home, ".omp", "agent") : "");
	const candidates = [
		home && join(home, "lsp.json"),
		home && join(home, ".lsp.json"),
		userDir && join(userDir, "lsp.json"),
		join(cwd, ".omp", "lsp.json"),
		join(cwd, "lsp.json"),
		join(cwd, ".lsp.json"),
	].filter(Boolean);
	for (const path of candidates) {
		const file = Bun.file(path);
		if (!(await file.exists())) continue;
		try {
			const parsed = (await file.json()) as Record<string, unknown>;
			const map = (typeof parsed.servers === "object" && parsed.servers ? parsed.servers : parsed) as Record<string, unknown>;
			for (const [name, cfg] of Object.entries(map)) {
				if (name === "idleTimeoutMs" || typeof cfg !== "object" || cfg === null) continue;
				servers[name] = { ...servers[name], ...(cfg as ServerConfigLike) };
			}
		} catch {
			// unreadable/invalid file: continue with the rest
		}
	}
	const out: Record<string, ServerConfigLike> = {};
	for (const [name, cfg] of Object.entries(servers)) {
		if (cfg.disabled || !cfg.command || !cfg.fileTypes?.length) continue;
		const local = join(cwd, "node_modules", ".bin", cfg.command);
		const resolved = (await Bun.file(local).exists()) ? local : Bun.which(cfg.command);
		if (resolved) out[name] = { ...cfg, resolvedCommand: resolved };
	}
	return out;
}

// ---------------------------------------------------------------------------
// Unified client interface
// ---------------------------------------------------------------------------

export interface LspClient {
	readonly name: string;
	/** Hierarchical symbols for a file (flat SymbolInformation answers are nested by range). */
	documentSymbol(file: string): Promise<DocumentSymbol[]>;
	prepareCallHierarchy(file: string, line: number, character: number): Promise<CallHierarchyItem[] | null>;
	outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null>;
	dispose(): Promise<void>;
}

/** Convert flat SymbolInformation[] into a DocumentSymbol tree by range containment. */
function normalizeSymbols(res: unknown): DocumentSymbol[] {
	if (!Array.isArray(res) || res.length === 0) return [];
	if ("selectionRange" in res[0]) return res as DocumentSymbol[];
	const flat = (res as SymbolInformation[])
		.map(s => ({ name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range, children: [] as DocumentSymbol[] }))
		.sort((a, b) => a.range.start.line - b.range.start.line || b.range.end.line - a.range.end.line);
	const roots: DocumentSymbol[] = [];
	const stack: DocumentSymbol[] = [];
	for (const s of flat) {
		while (stack.length && stack[stack.length - 1].range.end.line < s.range.end.line) stack.pop();
		(stack.length ? stack[stack.length - 1].children! : roots).push(s);
		stack.push(s);
	}
	return roots;
}

// ---------------------------------------------------------------------------
// Primary client: OMP's servers
// ---------------------------------------------------------------------------

class OmpClient implements LspClient {
	private client?: unknown;
	/** null = unknown; false once the server refused call hierarchy. */
	callHierarchy: boolean | null = null;

	constructor(
		readonly name: string,
		private readonly config: ServerConfigLike,
		private readonly bridge: OmpLspBridge,
		private readonly cwd: string,
	) {}

	private async open(file: string): Promise<unknown> {
		this.client ??= await this.bridge.getOrCreateClient(this.config, this.cwd, 30_000);
		await this.bridge.ensureFileOpen(this.client, file);
		return this.client;
	}

	async documentSymbol(file: string): Promise<DocumentSymbol[]> {
		const client = await this.open(file);
		const res = await this.bridge.sendRequest(client, "textDocument/documentSymbol", { textDocument: { uri: pathToUri(file) } }, undefined, 30_000);
		return normalizeSymbols(res);
	}

	async prepareCallHierarchy(file: string, line: number, character: number): Promise<CallHierarchyItem[] | null> {
		if (this.callHierarchy === false) return null;
		try {
			const client = await this.open(file);
			const res = await this.bridge.sendRequest(
				client,
				"textDocument/prepareCallHierarchy",
				{ textDocument: { uri: pathToUri(file) }, position: { line, character } },
				undefined,
				15_000,
			);
			this.callHierarchy = true;
			return Array.isArray(res) ? (res as CallHierarchyItem[]) : null;
		} catch {
			// Server refused (OMP's client does not declare the capability): route to the fallback.
			this.callHierarchy ??= false;
			return null;
		}
	}

	async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
		if (!this.client) return null;
		try {
			const res = await this.bridge.sendRequest(this.client, "callHierarchy/outgoingCalls", { item }, undefined, 15_000);
			return Array.isArray(res) ? (res as CallHierarchyOutgoingCall[]) : [];
		} catch {
			return null;
		}
	}

	async dispose(): Promise<void> {
		// OMP owns these server processes; leave them running.
		this.client = undefined;
	}
}

// ---------------------------------------------------------------------------
// Fallback client: own stdio process that declares callHierarchy support
// ---------------------------------------------------------------------------

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript",
	".cjs": "javascript", ".mts": "typescript", ".cts": "typescript", ".py": "python", ".go": "go", ".rs": "rust",
	".java": "java", ".rb": "ruby", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".kt": "kotlin",
	".swift": "swift", ".php": "php", ".lua": "lua", ".zig": "zig", ".ex": "elixir", ".exs": "elixir", ".scala": "scala",
};

export class StdioClient implements LspClient {
	private proc?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	private starting?: Promise<void>;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buffer = Buffer.alloc(0);
	private opened = new Set<string>();

	constructor(
		readonly name: string,
		private readonly config: ServerConfigLike,
		private readonly cwd: string,
	) {}

	private start(): Promise<void> {
		this.starting ??= (async () => {
			this.proc = Bun.spawn({
				cmd: [this.config.resolvedCommand ?? this.config.command, ...(this.config.args ?? [])],
				cwd: this.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			void this.readLoop(this.proc.stdout);
			void new Response(this.proc.stderr).text().catch(() => "");
			await this.request("initialize", {
				processId: process.pid,
				rootUri: pathToUri(this.cwd),
				workspaceFolders: [{ uri: pathToUri(this.cwd), name: "root" }],
				capabilities: {
					workspace: { configuration: true, workspaceFolders: true },
					textDocument: {
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: { dynamicRegistration: false },
						synchronization: { didSave: false },
					},
				},
				initializationOptions: this.config.initOptions ?? {},
			}, 60_000);
			this.notify("initialized", {});
			if (this.config.settings) this.notify("workspace/didChangeConfiguration", { settings: this.config.settings });
		})();
		return this.starting;
	}

	private async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			for await (const chunk of stream) {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				this.pump();
			}
		} catch {
			// server exited
		}
		for (const p of this.pending.values()) p.reject(new Error(`${this.name} exited`));
		this.pending.clear();
	}

	/** Content-Length framed JSON-RPC; lengths are in bytes, so frame on the byte buffer. */
	private pump(): void {
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"));
			if (!m) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + Number(m[1]);
			if (this.buffer.length < bodyEnd) return;
			const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			this.buffer = this.buffer.subarray(bodyEnd);
			let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
			try {
				msg = JSON.parse(body);
			} catch {
				continue;
			}
			if (msg.method !== undefined && msg.id !== undefined) {
				this.answerServerRequest(msg.id, msg.method, msg.params);
			} else if (msg.id !== undefined) {
				const entry = this.pending.get(Number(msg.id));
				if (!entry) continue;
				this.pending.delete(Number(msg.id));
				if (msg.error) entry.reject(new Error(msg.error.message ?? "LSP error"));
				else entry.resolve(msg.result);
			}
		}
	}

	/** Servers block on some of their own requests (pyright: workspace/configuration); answer them. */
	private answerServerRequest(id: number | string, method: string, params: unknown): void {
		let result: unknown = null;
		if (method === "workspace/configuration") {
			const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
			result = items.map(item => {
				const section = isRecord(item) && typeof item.section === "string" ? item.section : "";
				let value: unknown = this.config.settings ?? {};
				for (const key of section ? section.split(".") : []) value = isRecord(value) ? value[key] : undefined;
				return value ?? {};
			});
		} else if (method === "workspace/workspaceFolders") {
			result = [{ uri: pathToUri(this.cwd), name: "root" }];
		}
		this.send({ jsonrpc: "2.0", id, result });
	}

	private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
		const id = this.nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`${this.name}: ${method} timed out`));
		}, timeoutMs);
		this.pending.set(id, {
			resolve: v => {
				clearTimeout(timer);
				resolve(v);
			},
			reject: e => {
				clearTimeout(timer);
				reject(e);
			},
		});
		this.send({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(msg: unknown): void {
		const body = JSON.stringify(msg);
		this.proc?.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		void this.proc?.stdin.flush();
	}

	private async open(file: string): Promise<void> {
		await this.start();
		if (this.opened.has(file)) return;
		this.opened.add(file);
		const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: pathToUri(file),
				languageId: this.config.languageId ?? LANGUAGE_IDS[ext] ?? ext.slice(1),
				version: 1,
				text: await Bun.file(file).text(),
			},
		});
	}

	async documentSymbol(file: string): Promise<DocumentSymbol[]> {
		await this.open(file);
		try {
			return normalizeSymbols(await this.request("textDocument/documentSymbol", { textDocument: { uri: pathToUri(file) } }));
		} catch {
			return [];
		}
	}

	async prepareCallHierarchy(file: string, line: number, character: number): Promise<CallHierarchyItem[] | null> {
		await this.open(file);
		try {
			const res = await this.request("textDocument/prepareCallHierarchy", {
				textDocument: { uri: pathToUri(file) },
				position: { line, character },
			});
			return Array.isArray(res) ? (res as CallHierarchyItem[]) : null;
		} catch {
			return null;
		}
	}

	async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
		try {
			const res = await this.request("callHierarchy/outgoingCalls", { item });
			return Array.isArray(res) ? (res as CallHierarchyOutgoingCall[]) : [];
		} catch {
			return null;
		}
	}

	async dispose(): Promise<void> {
		if (!this.proc) return;
		try {
			await this.request("shutdown", null, 2000);
			this.notify("exit", null);
		} catch {
			// already gone
		}
		this.proc.kill();
		this.proc = undefined;
		this.starting = undefined;
		this.opened.clear();
	}
}

// ---------------------------------------------------------------------------
// Registry: one client per server, OMP's first, own client when refused
// ---------------------------------------------------------------------------

export class LspRegistry {
	private clients = new Map<string, LspClient>();
	private fallbacks = new Map<string, StdioClient>();
	private config?: LspConfigResult;
	private bridge: OmpLspBridge | null = null;

	constructor(private readonly cwd: string) {}

	async init(): Promise<LspConfigResult> {
		if (!this.config) {
			this.bridge = await loadOmpBridge();
			this.config = await loadLspConfig(this.cwd, this.bridge);
		}
		return this.config;
	}

	/** Type-intelligence server for a file (linters excluded), or null. */
	async clientForFile(file: string): Promise<LspClient | null> {
		const { servers } = await this.init();
		const ext = extOf(file);
		for (const [name, cfg] of Object.entries(servers)) {
			if (cfg.disabled || cfg.isLinter) continue;
			if (!cfg.fileTypes?.some(t => normalizeFileType(t) === ext)) continue;
			let client = this.clients.get(name);
			if (!client) {
				client = this.bridge ? new OmpClient(name, cfg, this.bridge, this.cwd) : new StdioClient(name, cfg, this.cwd);
				this.clients.set(name, client);
			}
			return client;
		}
		return null;
	}

	/**
	 * Client to use for call hierarchy. When OMP's client was refused (it does
	 * not declare the capability), route the server to our own client, which does.
	 */
	async callHierarchyClient(primary: LspClient): Promise<LspClient> {
		if (!(primary instanceof OmpClient) || primary.callHierarchy !== false) return primary;
		const { servers } = await this.init();
		let fb = this.fallbacks.get(primary.name);
		if (!fb) {
			fb = new StdioClient(primary.name, servers[primary.name], this.cwd);
			this.fallbacks.set(primary.name, fb);
		}
		return fb;
	}

	async describe(): Promise<{ source: "omp" | "self"; servers: string[] }> {
		const { source, servers } = await this.init();
		return { source, servers: Object.keys(servers) };
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.clients.values(), ...this.fallbacks.values()].map(c => c.dispose().catch(() => {})));
		this.clients.clear();
		this.fallbacks.clear();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function pathToUri(p: string): string {
	return "file://" + p.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
}

export function uriToPath(uri: string): string {
	return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function normalizeFileType(t: string): string {
	const lower = t.toLowerCase();
	return lower.startsWith(".") || !/^[a-z0-9]+$/.test(lower) ? lower : `.${lower}`;
}

function extOf(file: string): string {
	const base = file.replaceAll("\\", "/").split("/").pop() ?? "";
	const idx = base.lastIndexOf(".");
	return idx < 0 ? base.toLowerCase() : base.slice(idx).toLowerCase();
}
