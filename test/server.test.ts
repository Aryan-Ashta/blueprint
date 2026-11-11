import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { ViewerServer } from "../src/viewer/server";

let dir: string;
let store: Store;
let viewer: ViewerServer;
let base: string;
let token: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "bp-server-"));
	await Bun.write(join(dir, "src/a.ts"), "line1\nline2\nline3\n");
	await Bun.write(join(dir, "src/unindexed.ts"), "not in the graph\n");
	await Bun.write(join(dir, "secret.txt"), "top secret\n");
	store = new Store(join(dir));
	await store.writeGraph({ version: 1, symbols: [], edges: [], files: [{ path: "src/a.ts", hash: "h" }] });
	// `true` ignores its arguments, so "opening" a file never launches anything.
	viewer = new ViewerServer({ root: dir, store, editorCommand: "true $FILE $LINE" });
	const url = new URL(viewer.start());
	base = url.origin;
	token = url.searchParams.get("t")!;
});

afterAll(async () => {
	viewer.stop();
	await rm(dir, { recursive: true, force: true });
});

const get = (path: string, params: Record<string, string> = {}, init?: RequestInit) =>
	fetch(`${base}${path}?${new URLSearchParams({ ...params, t: token })}`, init);
const post = (path: string, body: unknown) => get(path, {}, { method: "POST", body: JSON.stringify(body) });

describe("access control", () => {
	test("requires the exact token", async () => {
		expect((await fetch(`${base}/api/blueprint`)).status).toBe(403);
		expect((await fetch(`${base}/api/blueprint?t=wrong`)).status).toBe(403);
		expect((await get("/api/blueprint")).status).toBe(200);
	});

	test("rejects a foreign Host header even with the token (DNS rebinding)", async () => {
		const res = await get("/api/blueprint", {}, { headers: { host: `evil.example:${new URL(base).port}` } });
		expect(res.status).toBe(403);
	});
});

describe("file access is limited to files the graph indexed", () => {
	test("code: indexed file is readable; absolute, traversal and unindexed paths are not", async () => {
		const ok = await get("/api/code", { file: "src/a.ts", start: "2", end: "3" });
		expect(ok.status).toBe(200);
		expect((await ok.json()).lines).toEqual(["line2", "line3"]);
		for (const file of [join(dir, "secret.txt"), "/etc/passwd", "../secret.txt", "src/../secret.txt", "src/../../etc/passwd", "src/unindexed.ts", ""]) {
			expect((await get("/api/code", { file })).status).toBe(404);
		}
		expect((await get("/api/code", { file: "src/./a.ts" })).status).toBe(200);
	});

	test("range picks must name an indexed file and a forward range", async () => {
		const ok = await post("/api/pick", { kind: "range", target: "src/./a.ts:1-2" });
		expect(ok.status).toBe(200);
		for (const target of ["/etc/passwd:1-5", `${join(dir, "secret.txt")}:1-1`, "../secret.txt:1-1", "src/unindexed.ts:1-1", "src/a.ts:3-1", "src/a.ts:0-2", "src/a.ts"]) {
			expect((await post("/api/pick", { kind: "range", target })).status).toBe(400);
		}
		// Only the valid pick was queued, with its path normalized.
		expect((await store.drainPicks()).map(p => p.target)).toEqual(["src/a.ts:1-2"]);
	});

	test("open in editor: indexed files only", async () => {
		expect((await post("/api/open", { file: "src/a.ts", line: 2 })).status).toBe(200);
		for (const file of ["/etc/passwd", "../secret.txt", "secret.txt", "src/unindexed.ts"]) {
			expect((await post("/api/open", { file, line: 1 })).status).toBe(404);
		}
	});
});
