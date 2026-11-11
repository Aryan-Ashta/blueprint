/** Small shared utilities. */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** SHA-256 hex of a string. */
export function hashString(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** SHA-256 hex of a file's bytes; null when unreadable. */
export async function hashFile(absPath: string): Promise<string | null> {
	try {
		const buf = await Bun.file(absPath).arrayBuffer();
		return createHash("sha256").update(new Uint8Array(buf)).digest("hex");
	} catch {
		return null;
	}
}

/** Repo-relative POSIX path. */
export function relPath(root: string, absPath: string): string {
	return relative(root, absPath).replaceAll("\\", "/");
}

/** Join a repo-relative path onto the root; an absolute `rel` is treated as relative, never passed through. */
export function absPath(root: string, rel: string): string {
	return join(root, rel);
}

export function stableId(file: string, qualifiedName: string, overload = 0): string {
	return overload > 0 ? `${file}#${qualifiedName}~${overload}` : `${file}#${qualifiedName}`;
}

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Simple unique-id suffix for node/pick ids. */
let idCounter = 0;
export function uniqueId(prefix: string): string {
	idCounter = (idCounter + 1) % 1_000_000;
	return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** JSONL reader that tolerates a missing file and blank lines. */
export async function readJsonl<T>(path: string): Promise<T[]> {
	const file = Bun.file(path);
	if (!(await file.exists())) return [];
	const text = await file.text();
	const out: T[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}

export async function appendJsonl<T>(path: string, record: T): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(record) + "\n");
}

/** The package's one object guard: narrows to a record whose fields are still `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
