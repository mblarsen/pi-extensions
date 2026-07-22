# pi-observational-memory-leanctx-bridge

Persist the branch-local ledger produced by [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) into the current project's [Lean Context](https://leanctx.com) knowledge base.

The bridge does not modify or import code from `pi-observational-memory`. It recognizes the extension's public session-ledger entry types:

- `om.observations.recorded`
- `om.reflections.recorded`

## Requirements

This bridge does not work standalone. Both of these Pi extensions must also be installed and enabled:

1. [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory), which creates the observations, reflections, and source provenance;
2. [`pi-lean-ctx`](https://www.npmjs.com/package/pi-lean-ctx), which provides the Lean Context knowledge tools and CLI integration.

Installing only this bridge will not provide observational memory or Lean Context. The `lean-ctx` executable must also be available on `PATH`, and Pi must run on Node.js 22.5 or newer for the built-in `node:sqlite` module. A complete package configuration is:

```json
{
  "packages": [
    "git:github.com/elpapi42/pi-observational-memory",
    "npm:pi-lean-ctx",
    "git:github.com/mblarsen/pi-extensions"
  ]
}
```

## Recommended agent instructions

The bridge can guide an agent after it calls `ctx_knowledge`, but it cannot force the agent to initiate a memory lookup. Copy this instruction into your global or project `AGENTS.md` file:

```md
- When a request may depend on project history, prior decisions, conventions, or earlier work, first use `ctx_knowledge` (`recall` or `search`) for semantic discovery; inspect the ranked results before recalling evidence, prefer the newest relevant reflection or highest-relevance observation, call `recall(id)` for only one result initially, and recall additional IDs only when the first result is incomplete, conflicting, or insufficient; fall back to `session_search` followed by `session_query` when persistent knowledge has no match, and re-read current files whenever present on-disk truth matters.
```

Use `~/AGENTS.md` to apply it across projects or a repository's `AGENTS.md` to scope it locally. Restart Pi or run `/reload` after changing agent instructions.

## Automatic synchronization

The current branch is scanned:

- when a session starts;
- before each agent run;
- before and after compaction;
- before and after `/tree` navigation and its optional branch summary;
- during session shutdown.

The before-tree scan persists memories from the branch being left. The after-tree scan reads the newly selected branch. A branch summary is not itself imported; `pi-observational-memory` may later turn it into a source-backed observation.

Automatic synchronization imports every reflection and only `high`- or `critical`-relevance observations into Lean Context. Low- and medium-relevance observations remain out of its semantic index unless explicitly imported with `--all`.

Every valid observation and reflection—including low/medium observations—is archived with its exact source entries in the persistent evidence database. Synchronization is serialized and content-aware: unchanged runtime facts are skipped, changed occurrences are upserted, and observations later dropped by OM are replaced in Lean Context with a `[historical:dropped]` label and `0.20` confidence.

## Manual synchronization

```text
/om:leanctx-sync
```

Submit unsynchronized reflections and high/critical observations to Lean Context and archive all unsynchronized OM evidence on the current branch.

```text
/om:leanctx-sync --all
```

Also import low- and medium-relevance observations. This is deliberate opt-in because those observations may be transient, superseded, or noisy.

```text
/om:leanctx-sync --rescan
```

Archive all matching records on the current branch again and import them with Lean Context's `replace` merge mode. This repairs the values and confidence of matching keys. Flags can be combined in either order as `--all --rescan`; argument completion excludes flags already present.

```text
/om:leanctx-sync off
```

Disable creation or updating of persisted memories for the current Pi session. Existing Lean Context semantic discovery, routing guidance, and archived-recall augmentation remain available read-only. Starting a new session or running `/reload` enables persistence again.

## Persistent evidence and recall

Exact source evidence is stored in one global SQLite database:

```text
~/.pi/agent/observational-memory/evidence.sqlite
```

The database is owner-only, uses WAL mode for concurrent Pi processes, and separates projects by canonical Git root. Occurrences retain project, session, ledger entry, record index, source entry, and supporting-observation identifiers. The same deterministic OM ID may therefore retain evidence from several sessions.

The bridge does not register a competing recall tool. Instead:

1. A `tool_call` hook synchronizes pending OM records before `ctx_knowledge` lookup or `recall`.
2. Lean Context performs semantic discovery using its condensed facts.
3. `ctx_knowledge` results containing OM keys tell the agent to inspect the ranking, recall only the single most relevant current-looking memory initially, and fetch another ID only if the first result is insufficient.
4. A `tool_result` hook for OM's existing `recall` returns all project-scoped archived occurrences when available, including the current occurrence just synchronized.
5. If Lean Context reports no match, its result reminds the agent to use an OM ID already visible in current memory.

Archive recall returns at most 20 occurrences and truncates rendered evidence at 40,000 characters or 1,500 lines. The database grows as sessions and branches are loaded and scanned; this version does not crawl unopened historical session files automatically.

## Mapping

| Observational memory | Persistent representation |
|---|---|
| Observation ID | Lean Context `om:observation:<id>` key + SQLite occurrence |
| Reflection ID | Lean Context `om:reflection:<id>` key + SQLite occurrence |
| Observation | `observational-memory-observation` category |
| Reflection | `observational-memory-reflection` category |
| Active observation relevance | Confidence: low `0.45`, medium `0.60`, high `0.80`, critical `0.95` |
| Dropped observation | `[historical:dropped]` label, confidence `0.20` |
| Reflection | Confidence `0.90` |
| Session, ledger and support/source IDs | SQLite provenance columns |
| Exact source entries | SQLite JSON evidence records |

All reflections and active high/critical observations are imported into Lean Context by default. Dropped observations of every original relevance are retained as low-confidence historical facts because an OM drop removes an observation from active compaction memory without invalidating its history.

Lean Context's JSONL importer replaces imported `source` metadata with its own import identifier. The bridge therefore uses the preserved OM ID in each Lean Context key as the join key into SQLite rather than relying on Lean Context provenance metadata.
