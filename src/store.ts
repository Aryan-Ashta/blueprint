/** Store: the `.blueprint/` directory — single source of truth for graph, nodes, and queues. */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	Blueprint,
	BlueprintConfig,
	BlueprintMeta,
	ChangeRecord,
	FactGraph,
	Pick,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { appendJsonl, readJsonl } from "./util";

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

	// -- viewer → agent queue ------------------------------------------------

	async drainPicks(): Promise<Pick[]> {
		const picks = await readJsonl<Pick>(this.picksPath);
		if (picks.length > 0) await Bun.write(this.picksPath, "");
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
