/** omp-blueprint data model: fact graph, blueprint nodes, picks, changes. */

// ---------------------------------------------------------------------------
// Fact graph (graph.json)
// ---------------------------------------------------------------------------

export type SymbolKind = "module" | "class" | "function" | "method" | "type" | "constant";

export interface SymbolRange {
	file: string; // repo-relative
	start: number; // 1-based inclusive
	end: number; // 1-based inclusive
}

export interface GraphSymbol {
	/** Stable id: `file#qualifiedName` (plus `~N` overload index when needed). */
	id: string;
	kind: SymbolKind;
	name: string; // qualified name within the file
	container?: string; // qualified name of the enclosing symbol, if any
	range: SymbolRange;
	signature?: string;
	doc?: string;
	/** One-line description written by a cheap model. Always model-written, never a fact. */
	summary?: string;
}

export type EdgeKind = "calls" | "contains" | "imports";

export interface GraphEdge {
	from: string; // symbol id
	to: string; // symbol id
	kind: EdgeKind;
	/** File + line of the call/import site, when known. */
	site?: { file: string; line: number };
}

export interface GraphFile {
	path: string;
	hash: string;
	server?: string; // LSP server name that indexed it
}

export interface FactGraph {
	version: number;
	symbols: GraphSymbol[];
	edges: GraphEdge[];
	files: GraphFile[];
}

// ---------------------------------------------------------------------------
// Blueprint nodes (blueprint.json)
// ---------------------------------------------------------------------------

export interface Citation {
	/** Symbol id in the fact graph. */
	symbol: string;
	file: string;
	start: number; // 1-based
	end: number; // 1-based
}

export interface Arrow {
	from: string; // child id
	to: string; // child id
	label?: string;
	proven: boolean;
}

export interface BlueprintNode {
	id: string;
	parent?: string;
	title: string; // at most 4 words
	blurb: string; // one sentence, at most 25 words
	children: string[]; // ordered; 3-9 for inner nodes
	arrows: Arrow[]; // between sibling children
	cites: Citation[];
	/** True if the node's existence rests on model judgment rather than graph structure. */
	inferred?: boolean;
	/** Hash of the cited ranges and cited symbols' signatures. Drives staleness. */
	sourceHash?: string;
	/** True after 4 failed checker rounds (arrows downgraded to inferred). */
	needsReview?: boolean;
	/** True while the cited code changed since this node was written. */
	stale?: boolean;
}

export interface Blueprint {
	version: number;
	root: string;
	nodes: Record<string, BlueprintNode>;
	/** Ordered top-level step ids (=== root.children). */
	steps?: string[];
}

// ---------------------------------------------------------------------------
// Meta, picks, changes
// ---------------------------------------------------------------------------

export interface BlueprintMeta {
	commit?: string;
	pluginVersion: string;
	modelsUsed?: { overview?: string; authors?: string; summaries?: string };
	builtAt?: string;
	/** Entry-point symbol ids seen at the last overview; a new one triggers a re-overview. */
	entryPoints?: string[];
	/** Top-level step id → root symbol ids assigned by the overview. */
	stepRoots?: Record<string, string[]>;
}

export interface Pick {
	id: string;
	timestamp: string;
	kind: "node" | "arrow" | "range";
	/** Node id, arrow `${from}->${to}`, or free-form description for a range. */
	target: string;
	note?: string;
}

export interface ChangeRecord {
	timestamp: string;
	tool: string;
	file: string;
	start: number;
	end: number;
	nodes: string[]; // node ids whose cites intersect the range
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BlueprintConfig {
	/** Model string or role alias for the overview. Default "@slow". */
	overviewModel: string;
	/** Model for subtree authors. Default "@task". */
	authorModel: string;
	/** Model for symbol summaries. Default "@tiny" (falls back to "@smol"). */
	summaryModel: string;
	/** Model for Ask answers; unset uses the session's current model. */
	askModel?: string;
	/** Cap on symbols per build; larger repos must scope to a subdirectory. */
	maxSymbols: number;
	/** Directory to scope the build to (repo-relative). Default repo root. */
	scope?: string;
	/** Re-run an incremental update automatically after agent turns. */
	autoUpdate: boolean;
	/** Run symbol summarization during build. */
	summarize: boolean;
	/** Open the viewer after a build completes. */
	openAfterBuild: boolean;
	/** Editor command for "Open in editor": `$FILE` and `$LINE` placeholders. */
	editorCommand?: string;
}

export const DEFAULT_CONFIG: BlueprintConfig = {
	overviewModel: "@slow",
	authorModel: "@task",
	summaryModel: "@tiny",
	maxSymbols: 4000,
	autoUpdate: false,
	summarize: true,
	openAfterBuild: false,
};

export const PLUGIN_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export type CheckSeverity = "reject" | "warn";

export interface CheckIssue {
	rule: string; // "C1".."C7"
	severity: CheckSeverity;
	message: string;
}
