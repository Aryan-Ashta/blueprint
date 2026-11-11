# omp-blueprint

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin that turns a repository into a checked, drill-down **blueprint**: the ordered steps the program takes, each opening onto a diagram of its parts, down to cited line ranges. Built from language-server facts, written by whatever models OMP routes to, shown in a local browser viewer that shares context with the agent both ways.

Design: [`omp-blueprint-spec.md`](https://github.com/Aryan-Ashta/mappr/blob/main/omp-blueprint-spec.md). Requires OMP ≥ 18.18.7.

## Install

```sh
omp plugin install omp-blueprint                    # from npm
omp plugin install github:Aryan-Ashta/mappr         # straight from GitHub
omp plugin link /path/to/this/repo                  # local development
```

The repository's languages need a language server OMP can launch (see OMP's `lsp.json` docs); call-hierarchy support gives the best arrows.

## Use

| Command | Effect |
|---|---|
| `/blueprint build` | Index with language servers, summarize symbols, write the overview, author each step in a restricted subagent, check everything. Runs in the background; asks first which providers will receive code. |
| `/blueprint update` | Re-index files whose content changed and re-author only stale subtrees (re-runs the overview if a step's root symbols vanished or a new entry point appeared). |
| `/blueprint open` | Start (if needed) and open the viewer. |
| `/blueprint status` | Blueprint size, staleness, models used, viewer URL, LSP path in use. |
| `/blueprint cancel` | Abort a running build or update. |

The agent gets two tools: `bp_lookup` (find nodes by text, path or symbol id) and `bp_context` (a node's parts, arrows and cited code).

**Viewer.** `127.0.0.1` only, random port, random token in the URL; all assets are local (ELK layout is bundled). A Figma-style canvas: scroll to pan, ⌘/Ctrl+scroll or pinch to zoom, Shift+1 to fit, Esc to go back; light and dark follow the system. Each level is a frame of cards coloured by top-level step; click a card to open its parts, or a leaf to open its cited code in the inspector panel. Solid connectors are proven by the call graph, dashed ones are inferred. Right-click a card, a connector, or selected lines (click / shift-click line numbers) to **Send to agent** — the pick arrives with your next prompt as a one-line `blueprint` chip — or **Open in editor**. Cards the agent edits get an orange badge; stale cards are greyed out; unverified ones carry a **Review** chip.

## Ask

Press **/** in the viewer (or click **✦ Ask**, or right-click a card → **Ask about this…**) and type a question. The answer streams into the panel from an agent session that, like the authors, can only read the blueprint (`bp_lookup`, `bp_context`) and the fact graph (`graph_*`) — no files, no shell — so it answers from checked parts and cited code and says so when the blueprint doesn't cover something. Parts it mentions are links: clicking one opens its diagram and highlights the card. Answers use your current omp model unless `askModel` is set; Ask is available while the omp session that started the viewer is running.

## Guarantees

Every node is validated against the fact graph before it is stored (spec §6):

| Rule | Check |
|---|---|
| C1 | Every citation names a graph symbol and lies inside its range. |
| C2 | Every solid arrow follows ≤ 2 `calls`/`imports` edges between cited symbols. |
| C3 | Unproven arrows must be marked `proven: false`. |
| C4 | Children cite only symbols in their parent's scope. |
| C5 | 3–9 children; titles ≤ 4 words; blurbs ≤ 25 words. |
| C6 | Leaves cite a range of ≤ 60 lines. |
| C7 | Siblings should not share a symbol (warning). |

Rejections go back to the author as the tool result; after 4 failed rounds, unreal or out-of-scope citations are dropped, unprovable arrows downgraded to inferred, and the node is flagged for review — so "every citation is real" and "every solid arrow exists" hold regardless of the model. Authors run in sessions restricted by OMP to the graph tools (`graph_symbol`, `graph_callees`, `graph_callers`, `graph_search`) and `submit_node`: they never see files.

## Configuration

Optional `.blueprint/config.json`:

```json
{
	"overviewModel": "@slow",
	"authorModel": "@task",
	"summaryModel": "@tiny",
	"askModel": "@task",
	"summarize": true,
	"maxSymbols": 4000,
	"scope": "packages/core",
	"autoUpdate": false,
	"openAfterBuild": false,
	"editorCommand": "code -g $FILE:$LINE"
}
```

Models accept any OMP model string or role alias; `@tiny` falls back to `@smol`; `askModel` defaults to the session's current model. `editorCommand` is split on whitespace and run without a shell; by default VS Code / Cursor / the OS opener is used.

## Storage

```
.blueprint/
  config.json      optional settings
  meta.json        commit indexed, plugin version, models used, step roots
  graph.json       fact graph (symbols, calls/contains/imports edges, file hashes)
  blueprint.json   node tree
  picks.jsonl      viewer → agent queue
  changes.jsonl    agent → viewer queue
  runs/            per-build logs: graph tool calls, checker verdicts
```

`.blueprint/` is added to `.git/info/exclude` on first build, never to `.gitignore`.

## LSP path

The plugin reuses OMP's own LSP client and config (`@oh-my-pi/pi-coding-agent/lsp/client`, `…/lsp/config`, undocumented internals) behind a startup check. If those imports are missing, or a server refuses call hierarchy through OMP's client, it launches its own stdio client that declares the capability, using the servers from your `lsp.json` files. Set `OMP_BLUEPRINT_LSP=self` to force the own client.

## Development

```sh
bun install
bun run typecheck
bun test
```
