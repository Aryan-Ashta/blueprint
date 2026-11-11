/**
 * Viewer server (spec §9): 127.0.0.1 only, random port, random token in the
 * URL. Serves the bundled SPA and ELK, the blueprint, code ranges, picks,
 * open-in-editor, Ask, and an SSE stream of `changed` / `stale` / `rebuilt` /
 * `answer`.
 */

import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import type { AskEvent, AskRequest } from "../ask";
import type { Store } from "../store";
import type { Pick } from "../types";
import { absPath, uniqueId } from "../util";

/** Answers one Ask, emitting progress; installed by the adapter, which owns the model session. */
export type AskHandler = (req: AskRequest, emit: (event: AskEvent) => void, signal: AbortSignal) => Promise<void>;

const MAX_QUESTION = 4000;

const APP_HTML = join(import.meta.dir, "app.html");
// Resolved through the package's own dependency, so nothing loads from a CDN.
const ELK_JS = Bun.resolveSync("elkjs/lib/elk.bundled.js", import.meta.dir);

export interface ViewerOptions {
	root: string;
	store: Store;
	/** Editor command with `$FILE` / `$LINE` placeholders, split on whitespace (no shell). */
	editorCommand?: string;
	onPick?: (pick: Pick) => void;
}

export class ViewerServer {
	readonly token = randomBytes(18).toString("base64url");
	private server?: ReturnType<typeof Bun.serve>;
	private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private encoder = new TextEncoder();
	private heartbeat?: ReturnType<typeof setInterval>;

	private asks = new Map<string, AbortController>();
	private askHandler?: AskHandler;

	constructor(private readonly opts: ViewerOptions) {}

	/** Enable Ask (the adapter re-installs it when the session context changes). */
	setAskHandler(handler: AskHandler | undefined): void {
		this.askHandler = handler;
	}

	get url(): string | undefined {
		return this.server ? `http://127.0.0.1:${this.server.port}/?t=${this.token}` : undefined;
	}

	start(): string {
		if (this.server) return this.url!;
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: req => this.handle(req),
		});
		this.heartbeat = setInterval(() => this.broadcastRaw(": ping\n\n"), 25_000);
		this.heartbeat.unref?.();
		return this.url!;
	}

	stop(): void {
		clearInterval(this.heartbeat);
		for (const a of this.asks.values()) a.abort();
		this.asks.clear();
		for (const c of this.clients) {
			try {
				c.close();
			} catch {
				// already closed
			}
		}
		this.clients.clear();
		this.server?.stop(true);
		this.server = undefined;
	}

	/** Push an event to every open viewer. */
	notify(event: "changed" | "stale" | "rebuilt" | "answer", data: unknown): void {
		this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
	}

	private broadcastRaw(chunk: string): void {
		const bytes = this.encoder.encode(chunk);
		for (const c of this.clients) {
			try {
				c.enqueue(bytes);
			} catch {
				this.clients.delete(c);
			}
		}
	}

	private authorized(req: Request, url: URL): boolean {
		// Reject DNS-rebinding hosts; only our own loopback origin is valid.
		const host = req.headers.get("host") ?? "";
		if (host !== `127.0.0.1:${this.server?.port}` && host !== `localhost:${this.server?.port}`) return false;
		const token = url.searchParams.get("t") ?? req.headers.get("x-blueprint-token");
		return token === this.token;
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (!this.authorized(req, url)) return new Response("forbidden", { status: 403 });
		try {
			switch (`${req.method} ${url.pathname}`) {
				case "GET /":
					return new Response(Bun.file(APP_HTML), { headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
				case "GET /elk.js":
					return new Response(Bun.file(ELK_JS), { headers: { "content-type": "text/javascript", ...NO_STORE } });
				case "GET /api/blueprint":
					return await this.getBlueprint();
				case "GET /api/code":
					return await this.getCode(url);
				case "POST /api/pick":
					return await this.postPick(req);
				case "POST /api/open":
					return await this.postOpen(req);
				case "POST /api/ask":
					return await this.postAsk(req);
				case "POST /api/ask/cancel":
					return await this.postAskCancel(req);
				case "GET /api/events":
					return this.events();
				default:
					return new Response("not found", { status: 404 });
			}
		} catch (err) {
			return json({ error: (err as Error).message }, 500);
		}
	}

	private async getBlueprint(): Promise<Response> {
		const [blueprint, meta, changes] = await Promise.all([
			this.opts.store.readBlueprint(),
			this.opts.store.readMeta(),
			this.opts.store.readChanges(),
		]);
		const changed = [...new Set(changes.flatMap(c => c.nodes))];
		return json({ blueprint, meta, changed, canAsk: !!this.askHandler });
	}

	/** Start answering; progress streams to every viewer as `answer` events tagged with the ask id. */
	private async postAsk(req: Request): Promise<Response> {
		const handler = this.askHandler;
		if (!handler) return json({ error: "Ask needs an active omp session" }, 503);
		const body = (await req.json()) as { question?: unknown; node?: unknown };
		const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
		if (!question) return json({ error: "question is required" }, 400);
		const node = typeof body.node === "string" ? body.node : undefined;
		const id = uniqueId("ask");
		const abort = new AbortController();
		this.asks.set(id, abort);
		const emit = (event: AskEvent) => this.notify("answer", { id, ...event });
		// Answered in the background; the response only hands back the id to follow.
		void handler({ question, node }, emit, abort.signal)
			.then(() => emit(abort.signal.aborted ? { kind: "error", text: "Stopped." } : { kind: "done" }))
			.catch(err => emit({ kind: "error", text: abort.signal.aborted ? "Stopped." : (err as Error).message }))
			.finally(() => this.asks.delete(id));
		return json({ id });
	}

	private async postAskCancel(req: Request): Promise<Response> {
		const { id } = (await req.json()) as { id?: unknown };
		const abort = typeof id === "string" ? this.asks.get(id) : undefined;
		abort?.abort();
		return json({ ok: !!abort });
	}

	/** Lines of an indexed file. Only files present in the fact graph are readable. */
	private async getCode(url: URL): Promise<Response> {
		const file = normalize(url.searchParams.get("file") ?? "").replaceAll("\\", "/");
		if (!file || file.startsWith("..") || file.startsWith("/")) return json({ error: "bad file" }, 400);
		const graph = await this.opts.store.readGraph();
		if (!graph?.files.some(f => f.path === file)) return json({ error: "file not in blueprint" }, 404);
		const f = Bun.file(absPath(this.opts.root, file));
		if (!(await f.exists())) return json({ error: "file missing" }, 404);
		const lines = (await f.text()).split("\n");
		const start = Math.max(1, Number(url.searchParams.get("start")) || 1);
		const end = Math.min(lines.length, Number(url.searchParams.get("end")) || lines.length);
		return json({ file, start, end, total: lines.length, lines: lines.slice(start - 1, end) });
	}

	private async postPick(req: Request): Promise<Response> {
		const body = (await req.json()) as Partial<Pick>;
		if (!body.kind || !["node", "arrow", "range"].includes(body.kind) || typeof body.target !== "string") {
			return json({ error: "pick needs kind (node|arrow|range) and target" }, 400);
		}
		const pick: Pick = {
			id: uniqueId("pick"),
			timestamp: new Date().toISOString(),
			kind: body.kind,
			target: body.target.slice(0, 500),
			note: typeof body.note === "string" ? body.note.slice(0, 2000) : undefined,
		};
		await this.opts.store.appendPick(pick);
		this.opts.onPick?.(pick);
		return json({ ok: true, pick });
	}

	private async postOpen(req: Request): Promise<Response> {
		const body = (await req.json()) as { file?: string; line?: number };
		const file = normalize(body.file ?? "").replaceAll("\\", "/");
		if (!file || file.startsWith("..") || file.startsWith("/")) return json({ error: "bad file" }, 400);
		const abs = absPath(this.opts.root, file);
		const line = Math.max(1, Math.floor(Number(body.line) || 1));
		const argv = editorArgv(this.opts.editorCommand, abs, line);
		const proc = Bun.spawn(argv, { cwd: this.opts.root, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		proc.unref();
		return json({ ok: true, command: argv[0] });
	}

	private events(): Response {
		let self: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				self = controller;
				this.clients.add(controller);
				controller.enqueue(this.encoder.encode(": connected\n\n"));
			},
			cancel: () => {
				if (self) this.clients.delete(self);
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
		});
	}
}

const NO_STORE = { "cache-control": "no-store" };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...NO_STORE } });
}

/** Build the editor argv: configured template, else VS Code if present, else the OS opener. */
export function editorArgv(template: string | undefined, file: string, line: number): string[] {
	if (template?.trim()) {
		return template
			.trim()
			.split(/\s+/)
			.map(part => part.replaceAll("$FILE", file).replaceAll("$LINE", String(line)));
	}
	if (Bun.which("code")) return ["code", "-g", `${file}:${line}`];
	if (Bun.which("cursor")) return ["cursor", "-g", `${file}:${line}`];
	return process.platform === "darwin" ? ["open", file] : ["xdg-open", file];
}
