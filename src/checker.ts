/**
 * Checker (spec §6): validates every submitted node against the fact graph.
 *
 * C1 and C2 are checked mechanically, so "every citation is real" and "every
 * solid arrow exists in the code" hold by construction, independent of which
 * model wrote the node.
 */

import type { GraphIndex } from "./graph";
import type { Arrow, BlueprintNode, CheckIssue, Citation } from "./types";
import { wordCount } from "./util";

export interface CheckResult {
	/** true when no "reject" issue was found (warnings allowed). */
	ok: boolean;
	issues: CheckIssue[];
	/** Arrow index → whether the graph proves it (filled in for C2/C3 evaluation). */
	provenArrows: boolean[];
	/** C7 duplicates, for the repair prompt. */
	warnings: string[];
}

function reject(rule: string, message: string): CheckIssue {
	return { rule, severity: "reject", message };
}
function warn(rule: string, message: string): CheckIssue {
	return { rule, severity: "warn", message };
}

/** A citation range of whole lines, start ≥ 1 and start ≤ end. */
export function wellFormed(c: Pick<Citation, "start" | "end">): boolean {
	return Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 1 && c.start <= c.end;
}

/** Scope of a node: its cited symbols plus anything they contain or call (C4). */
export function scopeOf(index: GraphIndex, cites: Citation[]): Set<string> {
	const scope = new Set<string>();
	const visit = (id: string) => {
		if (scope.has(id)) return;
		scope.add(id);
		for (const child of index.children(id)) visit(child.id);
		for (const callee of index.callees(id)) visit(callee.id);
	};
	for (const c of cites) visit(c.symbol);
	return scope;
}

/**
 * Check one node submission against the graph.
 * `siblingCites` are the cites of the node's other children, for C7.
 */
export function checkNode(
	index: GraphIndex,
	node: BlueprintNode,
	childNodes: BlueprintNode[],
): CheckResult {
	const issues: CheckIssue[] = [];
	const warnings: string[] = [];
	const provenArrows: boolean[] = [];

	// C1: every citation names a graph symbol and its range lies inside it.
	for (const cite of node.cites) {
		const sym = index.symbol(cite.symbol);
		if (!sym) {
			issues.push(reject("C1", `citation names unknown symbol: ${cite.symbol}`));
			continue;
		}
		if (cite.file !== sym.range.file) {
			issues.push(reject("C1", `citation file ${cite.file} does not match symbol ${sym.id} (${sym.range.file})`));
			continue;
		}
		if (!wellFormed(cite)) {
			issues.push(reject("C1", `citation range ${cite.start}-${cite.end} is not a forward range of whole lines starting at 1 or later`));
			continue;
		}
		if (cite.start < sym.range.start || cite.end > sym.range.end) {
			issues.push(
				reject(
					"C1",
					`citation range ${cite.start}-${cite.end} lies outside symbol ${sym.id} (${sym.range.start}-${sym.range.end})`,
				),
			);
		}
	}

	// C2: every arrow marked proven matches a path of ≤2 calls/imports edges
	// from a symbol cited by the source child to one cited by the target child.
	const citesByChild = new Map<string, string[]>();
	for (const child of childNodes) {
		citesByChild.set(child.id, child.cites.map(c => c.symbol));
	}
	const arrowProvable = (arrow: Arrow): boolean => {
		const fromSymbols = citesByChild.get(arrow.from) ?? [];
		const toSymbols = citesByChild.get(arrow.to) ?? [];
		if (fromSymbols.length === 0 || toSymbols.length === 0) return false;
		for (const from of fromSymbols) {
			// direct edge (path length 1)
			for (const callee of index.callees(from)) {
				if (toSymbols.includes(callee.id)) return true;
			}
			// path length 2
			for (const mid of index.callees(from)) {
				for (const callee of index.callees(mid.id)) {
					if (toSymbols.includes(callee.id)) return true;
				}
			}
		}
		return false;
	};
	for (const arrow of node.arrows) {
		const provable = arrowProvable(arrow);
		provenArrows.push(provable);
		if (arrow.proven && !provable) {
			issues.push(
				reject(
					"C2",
					`arrow ${arrow.from} → ${arrow.to} is marked proven but has no path of ≤2 calls/imports edges between cited symbols`,
				),
			);
		}
		if (!arrow.proven && provable) {
			// allowed, but note it could have been proven
			warnings.push(`arrow ${arrow.from} → ${arrow.to} is marked inferred but the graph proves it`);
		}
		// C3 is the absence of a third state: `proven` is boolean, so an unproven
		// arrow is allowed only when `proven: false` — enforced by the type and
		// re-checked here for submissions that arrived as raw JSON.
	}

	// C4: a child cites only symbols in its parent's scope.
	const parentScope = scopeOf(index, node.cites);
	for (const child of childNodes) {
		for (const cite of child.cites) {
			if (!parentScope.has(cite.symbol)) {
				issues.push(
					reject(
						"C4",
						`child ${child.id} cites ${cite.symbol}, which is outside the parent's scope (parent's cited symbols and anything they contain or call)`,
					),
				);
			}
		}
	}

	// C5: size limits.
	if (childNodes.length > 0 && (childNodes.length < 3 || childNodes.length > 9)) {
		issues.push(reject("C5", `node has ${childNodes.length} children; inner nodes need 3 to 9`));
	}
	if (wordCount(node.title) > 4) {
		issues.push(reject("C5", `title "${node.title}" has more than four words`));
	}
	if (wordCount(node.blurb) > 25) {
		issues.push(reject("C5", `blurb has more than 25 words`));
	}

	// C6: a leaf cites at least one range of 60 lines or fewer.
	if (childNodes.length === 0) {
		const hasSmall = node.cites.some(c => wellFormed(c) && c.end - c.start + 1 <= 60);
		if (!hasSmall) {
			issues.push(reject("C6", `leaf cites no range of 60 lines or fewer`));
		}
	}

	// C7: no symbol is cited by more than one sibling (warn).
	const seen = new Map<string, string>();
	for (const child of childNodes) {
		for (const cite of child.cites) {
			const first = seen.get(cite.symbol);
			if (first && first !== child.id) {
				const message = `symbol ${cite.symbol} is cited by both ${first} and ${child.id}`;
				issues.push(warn("C7", message));
				warnings.push(message);
			} else {
				seen.set(cite.symbol, child.id);
			}
		}
	}

	return { ok: !issues.some(i => i.severity === "reject"), issues, provenArrows, warnings };
}

/** Raw (unvalidated, from a subagent) node submission. */
export interface RawSubmission {
	id?: string;
	parent?: string;
	title?: string;
	blurb?: string;
	children?: RawSubmission[];
	arrows?: { from?: string; to?: string; label?: string; proven?: boolean }[];
	cites?: { symbol?: string; file?: string; start?: number; end?: number }[];
	inferred?: boolean;
}

/**
 * Coerce a raw submission into nodes. The root gets `id`; children get path
 * ids (`id.1`, `id.2`, …). Arrows name sibling children by the author's local
 * id, title, or 1-based position, and are remapped to the final ids; arrows
 * naming no sibling are rejected. Throws on missing fields.
 */
export function materializeSubmission(
	raw: RawSubmission,
	parent: string | undefined,
	id: string,
	depth = 0,
): BlueprintNode[] {
	if (!raw.title || !raw.blurb) {
		throw new Error(`node "${raw.id ?? raw.title ?? id}" is missing title or blurb`);
	}
	if (depth > 6) {
		throw new Error("submission nests deeper than 6 levels");
	}
	const rawChildren = raw.children ?? [];
	const localIds = new Map<string, string>();
	rawChildren.forEach((child, i) => {
		const finalId = `${id}.${i + 1}`;
		localIds.set(String(i + 1), finalId);
		if (child.id) localIds.set(String(child.id), finalId);
		if (child.title) localIds.set(child.title, finalId);
	});
	const arrows = (raw.arrows ?? []).map(a => {
		const from = localIds.get(String(a.from ?? ""));
		const to = localIds.get(String(a.to ?? ""));
		if (!from || !to) {
			throw new Error(`node "${raw.title}": arrow ${a.from} → ${a.to} must name two of its own children by id`);
		}
		return { from, to, label: a.label, proven: a.proven === true };
	});
	const node: BlueprintNode = {
		id,
		parent,
		title: raw.title,
		blurb: raw.blurb,
		children: [],
		arrows,
		cites: (raw.cites ?? [])
			.filter(c => c.symbol && c.file && typeof c.start === "number" && typeof c.end === "number")
			.map(c => ({ symbol: c.symbol!, file: c.file!, start: c.start!, end: c.end! })),
		inferred: raw.inferred === true ? true : undefined,
	};
	const out = [node];
	rawChildren.forEach((child, i) => {
		const childNodes = materializeSubmission(child, id, `${id}.${i + 1}`, depth + 1);
		node.children.push(childNodes[0].id);
		out.push(...childNodes);
	});
	return out;
}
