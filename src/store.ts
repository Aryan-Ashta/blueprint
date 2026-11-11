/** Store: the `.blueprint/` directory — single source of truth for graph, nodes, and queues. */

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type {
	Blueprint,
	BlueprintConfig,
	BlueprintMeta,
	ChangeRecord,
	FactGraph,
	Pick,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { appendJsonl, readJsonl, uniqueId } from "./util";

/** A range pick target, `file:start-end`. */
export interface RangeTarget {
	file: string;
	start: number;
	end: number;
}

export function parseRangeTarget(target: string): RangeTarget | null {
	const m = /^(.+):(\d+)-(\d+)$/.exec(target);
	if (!m) return null;
	const start = Number(m[2]);
	const end = Number(m[3]);
	return start >= 1 && start <= end ? { file: m[1], start, end } : null;
}

export class Store {
	readonly dir: string;

	constructor(readonly projectRoot: string) {
		this.dir = join(projectRoot, ".blueprint");
	}

	get graphPath(): string {
		return join(this.dir, "graph.json");
	}
	get blueprintPath(): string {
		return join(this.dir, "blueprint.json");
	}
	get metaPath(): string {
		return join(this.dir, "meta.json");
	}
	get configPath(): string {
		return join(this.dir, "config.json");
	}
	get picksPath(): string {
		return join(this.dir, "picks.jsonl");
	}
	get changesPath(): string {
		return join(this.dir, "changes.jsonl");
	}
	get runsDir(): string {
		return join(this.dir, "runs");
	}

	async exists(): Promise<boolean> {
		return await Bun.file(this.blueprintPath).exists();
	}

	/** Create the store, add `.blueprint/` to `.git/info/exclude` (never `.gitignore`). */
	async ensure(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await mkdir(this.runsDir, { recursive: true });
		// Exclude via git's local info file so nothing in the repository changes.
		const info = join(this.projectRoot, ".git", "info", "exclude");
		try {
			const file = Bun.file(info);
			let text = "";
			if (await file.exists()) text = await file.text();
			if (!text.split("\n").some(l => l.trim() === ".blueprint/")) {
				await Bun.write(info, text.replace(/\n*$/, "\n") + ".blueprint/\n", { createPath: true });
			}
		} catch {
			// Not a git repo (or no .git dir): nothing to exclude.
		}
	}

	async readConfig(): Promise<BlueprintConfig> {
		const file = Bun.file(this.configPath);
		if (!(await file.exists())) return { ...DEFAULT_CONFIG };
		try {
			const stored = (await file.json()) as Partial<BlueprintConfig>;
			return { ...DEFAULT_CONFIG, ...stored };
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}

	async writeConfig(config: BlueprintConfig): Promise<void> {
		await this.ensure();
		await Bun.write(this.configPath, JSON.stringify(config, null, "\t") + "\n");
	}

	async readGraph(): Promise<FactGraph | null> {
		const file = Bun.file(this.graphPath);
		if (!(await file.exists())) return null;
		try {
			return (await file.json()) as FactGraph;
		} catch {
			return null;
		}
	}

	async writeGraph(graph: FactGraph): Promise<void> {
		await this.ensure();
		await Bun.write(this.graphPath, JSON.stringify(graph));
	}

	async readBlueprint(): Promise<Blueprint | null> {
		const file = Bun.file(this.blueprintPath);
		if (!(await file.exists())) return null;
		try {
			return (await file.json()) as Blueprint;
		} catch {
			return null;
		}
	}

	async writeBlueprint(bp: Blueprint): Promise<void> {
		await this.ensure();
		await Bun.write(this.blueprintPath, JSON.stringify(bp));
	}

	async readMeta(): Promise<BlueprintMeta | null> {
		const file = Bun.file(this.metaPath);
		if (!(await file.exists())) return null;
		try {
			return (await file.json()) as BlueprintMeta;
		} catch {
			return null;
		}
	}

	async writeMeta(meta: BlueprintMeta): Promise<void> {
		await this.ensure();
		await Bun.write(this.metaPath, JSON.stringify(meta, null, "\t") + "\n");
	}

	/**
	 * The repo-relative path of `file` if it is a file the fact graph indexed,
	 * else null. Everything the viewer or a pick can read or open must pass this:
	 * it rejects absolute paths, `..` traversal and any file outside the graph.
	 */
	async indexedFile(file: string): Promise<string | null> {
		if (!file || file.includes("\0") || file.startsWith("/") || /^[a-zA-Z]:/.test(file)) return null;
		const normalized = posix.normalize(file.replaceAll("\\", "/"));
		if (normalized.startsWith("../") || normalized === "..") return null;
		const graph = await this.readGraph();
		return graph?.files.some(f => f.path === normalized) ? normalized : null;
	}

	// -- viewer → agent queue ------------------------------------------------

	/**
	 * Take every queued pick exactly once. The queue file is renamed aside
	 * before it is read, so a pick appended meanwhile lands in a fresh
	 * picks.jsonl for the next drain instead of being truncated away. Files
	 * left behind by a drain that crashed are picked up here too.
	 */
	async drainPicks(): Promise<Pick[]> {
		try {
			await rename(this.picksPath, join(this.dir, `picks.jsonl.draining-${uniqueId("d")}`));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		let names: string[];
		try {
			names = (await readdir(this.dir)).filter(n => n.startsWith("picks.jsonl.draining-")).sort();
		} catch {
			return [];
		}
		const picks: Pick[] = [];
		for (const name of names) {
			const path = join(this.dir, name);
			picks.push(...(await readJsonl<Pick>(path)));
			await rm(path, { force: true });
		}
		return picks;
	}

	async appendPick(pick: Pick): Promise<void> {
		await this.ensure();
		await appendJsonl(this.picksPath, pick);
	}

	// -- agent → viewer queue ------------------------------------------------

	async appendChange(change: ChangeRecord): Promise<void> {
		await this.ensure();
		await appendJsonl(this.changesPath, change);
	}

	async readChanges(): Promise<ChangeRecord[]> {
		return await readJsonl<ChangeRecord>(this.changesPath);
	}

	/** Clear the change marker queue (viewer shows markers until next rebuild). */
	async clearChanges(): Promise<void> {
		if (await Bun.file(this.changesPath).exists()) await Bun.write(this.changesPath, "");
	}

	// -- runs ----------------------------------------------------------------

	runPath(buildId: string): string {
		return join(this.runsDir, `${buildId}.jsonl`);
	}

	async logRun(buildId: string, entry: Record<string, unknown>): Promise<void> {
		await this.ensure();
		await appendJsonl(this.runPath(buildId), { timestamp: new Date().toISOString(), ...entry });
	}
}
