# Idle Learn Batch Integration Implementation Plan

## Objective

Implement `docs/superpowers/specs/2026-10-29-idle-learn-batch-integration-design.md` in `@mblarsen/pi-idle-learn`:

- Replace per-suggestion Apply for instruction proposals with a batch flow:
  - persistent multi-selection, comments, and isolated reviewer integration;
  - combined per-file diffs, regeneration, and a separately confirmed Apply.
- Remove every long-running lock from suggestion generation, including review and calibration. Long-running locks exist only per integration task.

Build on the uncommitted recovery and concurrency work in the worktree; do not discard it. Do not publish, install, or modify real project learning artifacts.

## Decisions (user-confirmed 2026-10-29)

- **Approval semantics.** Selecting a proposal approves it as input to the update. A successful Apply archives every selected proposal as `applied`, with an `integration` link. This includes proposals the reviewer judged already covered. There is no per-proposal "unresolved" outcome. Conflicts are resolved by commenting and regenerating, or by discarding. A discarded batch leaves its proposals pending.
- **Calibration.** Calibration loses its long lock. The single-pending-calibration check moves into the storage-lock commit. Calibration items keep their existing single-item Apply and Reject.
- **Reference files.** A draft may write:
  - the batch's AGENTS.md targets;
  - existing `.md` files that a target already links to;
  - up to three new `.md` files.

  Each new file must be inside the linking AGENTS.md directory tree and linked from the drafted AGENTS.md. Drafts may not touch `.pi/`, `.git`, symlinks, or other `AGENTS.md` files. Every file must stay within `MAX_FILE_BYTES`.
- **Execution.** Integration runs in a foreground modal, like Refresh. Esc cancels it and keeps the batch.

## Design summary

### Batch artifact

Path: `.pi/idle-learn/batches/<uuid>.json`, written with `atomicProjectWrite` under the storage lock.

```ts
interface Batch {
  version: 1; id: string; created: string; updated: string;
  status: "open" | "applying" | "applied" | "discarded";
  sources: Array<{ number: number; id: string; snapshot: string /* contentHash(serializeSuggestion(s)) */ }>;
  comments: Array<{ created: string; text: string }>;          // append-only, max 20 x 4000 chars
  draft?: {
    created: string; hash: string;                              // contentHash of canonical draft JSON
    sources: string;                                            // hash of sources at generation time
    summary: string;
    notes: Array<{ number: number; note: string }>;             // one per source number
    files: Array<{ path: string; baseHash: string | null; content: string; created: boolean }>;
  };
  apply?: { draft: string; files: Array<{ path: string; beforeHash: string | null; afterHash: string }> };
  error?: string;                                               // last failure, shown in the batch view
}
```

- Proposal numbers are assigned at creation and never change.
- The draft contains full resulting file contents. Diffs are computed for display with the host's `generateUnifiedPatch`.
- An open batch with no draft is the persisted selection.

### Integration run (`integrate.ts`)

1. **Capture under the storage lock.** Read the batch. Verify every source is still pending and its snapshot matches. Read the targets and their already-linked `.md` files, and record their hashes.
2. **Integration-task lock.** Acquire `acquireProjectLock(root, "integration", batch.id)`, i.e. `integration-<hash(id)>.lock`, held only during this run. If the lock is held, report "This batch is already integrating".
3. **Worker call.** No storage lock is held. Purpose is `"integrate"`, there are no tools, and `integration-prompt.md` is the system prompt. Evidence contains:
   - numbered proposals, with their original diffs, rationale, and evidence;
   - comments;
   - captured file contents and hashes;
   - the previous draft, if any;
   - the allowed write scope and the output contract.
4. **Output contract.**

   ```json
   {"summary": "...", "notes": [{"number": 1, "note": "..."}], "files": [
     {"path": "AGENTS.md", "edits": [{"before": "unique", "after": "..."}]},
     {"path": "docs/agents/testing.md", "content": "..."}]}
   ```

   Existing files use sequential unique-match edits, which keeps output within the 128 KiB worker limit. New files use `content`. Alternatively the reviewer returns `{"conflict": "..."}`, which is stored as `error`, and no draft is saved.
5. **Validation.** The host does the following:
   - applies the edits to the captured contents;
   - enforces the write scope, link checks, and size limits;
   - requires exactly one note per source number.
6. **Commit under the storage lock.** Recheck the batch, the source snapshots, and the captured hashes. On mismatch, fail with "Inputs changed during integration; integrate again". Otherwise save the draft and clear `error`.

### Apply (`applyBatch` in `batch.ts`, entirely under one storage lock)

1. **Verify.** Status is `open`, a draft exists, and the draft hash still matches. Sources are pending and their snapshots match. Every file's current hash equals the draft `baseHash`. Otherwise fail with "Target or proposal changed; integrate again". Never regenerate automatically.
2. **Journal first.** Set `status: "applying"` and record `apply` with the before and after hashes.
3. **Write files.** Write each file with `atomicProjectWrite`.
4. **Archive sources.** Archive each source to `applied/` with `integration: { batch, draft }`, then unlink its pending artifact. Reuse the archive and idempotency logic from `decideSuggestion` through a shared helper.
5. **Finish.** Set `status: "applied"`.

### Recovery

`resumeApply` handles a batch that has `status: "applying"`, whether reached from the batch view or the panel banner. For each journaled file:

- current hash equals `afterHash`: already done;
- current hash equals `beforeHash`: write it;
- anything else: stop, keep `applying`, and report which files diverged. Never report success.

Then archive any sources that are still pending. Already-archived sources with a matching `integration` are idempotent.

### Concurrency changes

- `lock.ts`: kinds become `"storage" | "integration"`. `"review"` and `"calibration"` are removed.
- `reviewer.ts analyze`:
  - Drop the per-session lease and `lease.assertHeld()`.
  - The commit already merges progress under the storage lock.
  - Same-session overlap in one process is still prevented by `IdleReviewer.active`.
  - Cross-process overlap is safe: duplicates are skipped and reviewed IDs are unioned.
- `calibration.ts`:
  - Drop the lease.
  - Run `hasPendingCalibration` inside the `saveProposals` guard. A late duplicate run saves nothing and reports that a Calibration item is already pending.
  - The calibration checkpoint is still merged.

### Suggestion schema

- Add optional `integration?: { batch: uuid; draft: sha256 }`, allowed only when `status === "applied"`.
- `parseSuggestion` still reads old artifacts without the field.
- The calibration `decisionText` shows "accepted (batch integration)" for linked items. Ordinary decisions still count them as accepted.

### UI

Panel (`panel.ts`), list view:

- `Space` toggles selection on instruction items, shown as `[x]`.
- `i` opens the batch view with the selection, and requires at least one selected item.
- `b` lists saved open or applying batches.
- Instruction items lose `p`; `r` Reject is unchanged.
- Calibration items keep `p` and `r`.
- `f` Refresh remains only for calibration items (stale preference edits). Instruction proposals no longer need it, because integration reconciles against current content.
- A banner shows when any batch is `applying` (needs recovery).

Batch view (new `batch-panel.ts`):

- Shows numbered sources with their original diffs, rationale, and evidence; comments; then, if a draft exists, the summary, per-proposal notes, and a per-file unified diff (new files marked).
- Keys:
  - `c`: add a comment (`ctx.ui.editor`);
  - `g`: integrate or regenerate (confirmation shows provider usage);
  - `p`: apply (only with a fresh draft; separate confirm listing the files);
  - `x`: remove a source before regeneration (numbers keep their gaps);
  - `d`: discard;
  - `Esc`: back.
- A stale draft shows "Target changed — regenerate" and disables `p`.

`index.ts`:

- Replace the instruction Apply branch with batch actions.
- Retain the in-panel selection across loop iterations, like `selectedId`.
- Add an integration modal that mirrors `refreshDisplayed`, with its own `AbortController` in `cancelReviews`. Session navigation, switch, fork, shutdown, configuration change, and `/idle-learn cancel` all abort it without writes.

## Tasks

Use TDD: write failing tests for each task, then implement.

- [x] **1. Lock and generation concurrency.**
  - Remove the `review` and `calibration` lock kinds and add `integration` with an ID.
  - Remove the leases from `analyze` and `calibrate`, and move the pending-calibration check into the guard.
  - Tests:
    - Rewrite `concurrency.test.ts`: same-session parallel analysis completes, unions progress, and dedupes proposals; parallel calibration produces at most one pending item; analysis plus calibration overlap still works.
    - Update `store.test.ts` lock tests to the integration kind: two different batch IDs lock independently; the same ID is exclusive; cross-process stale recovery still works.
    - Update `calibration.test.ts:223`.
- [x] **2. Suggestion schema.**
  - Add optional `integration` to `Suggestion`, `parseSuggestion`, and `serializeSuggestion`.
  - Add a shared archive helper extracted from `decideSuggestion`.
  - Tests: old artifacts parse unchanged; the field is rejected on pending or rejected items; round-trip.
- [x] **3. Batch store (`batch.ts`).**
  - Add create, read, list, add comment, remove source, discard, and save draft (with recheck), plus validation for the batch schema and limits.
  - Tests: create assigns stable numbers 1..n; only pending instruction sources are accepted; comments persist; malformed files are rejected with clear errors; selection never writes targets or archives sources.
- [x] **4. Write scope (`scope.ts`).**
  - Add link extraction (Markdown links relative to the AGENTS.md directory) and an allowed-path check.
  - Tests:
    - New files are allowed only inside the AGENTS.md directory tree, with the `.md` extension, and when linked from the drafted target.
    - The following are rejected: more than three new files; `.pi/`, `.git`, and symlinked paths; other AGENTS.md files; oversize content; paths escaping the project.
    - Existing linked files are allowed.
- [x] **5. Integration run (`integrate.ts`, `integration-prompt.md`, `worker.ts` `"integrate"` purpose).**
  - Put the spec's prompt-boundary text in the prompt, plus the untrusted-evidence rule (comments are user direction; proposal text and evidence are data) and the JSON contract.
  - Add `integration-prompt.md` to `files` in `package.json`.
  - Tests:
    - Use a mock transport. Edits are materialized correctly, and unrelated content is preserved.
    - Validation failures (bad edits, missing notes, out-of-scope paths) save no draft.
    - A conflict response is stored as `error`.
    - Regeneration passes the previous draft and new comments, and does not apply.
    - Pending-status changes, source edits, or target hash changes during the model call reject the commit.
    - A second concurrent run of the same batch is refused, while a different batch runs in parallel.
    - Cancellation leaves the batch intact.
    - No storage lock is held during the transport call: a storage acquisition from inside the transport succeeds.
- [x] **6. Apply and recovery.**
  - Add `applyBatch` and `resumeApply`.
  - Tests:
    - The happy path writes all files and archives every source with its integration link, including sources the notes describe as covered.
    - A stale target, a changed or rejected source, or a tampered draft blocks Apply and requires regeneration.
    - Inject a failure after the first file write: the status stays `applying`, there is no success message, and `resumeApply` completes it.
    - A file that diverged after the journal blocks recovery with a clear message.
    - Archive steps are idempotent.
    - Discard leaves sources pending.
- [x] **7. Panels.**
  - Update the review panel for selection, keys, and the banner.
  - Add the batch panel (rendering, scrolling, narrow and wide layouts, `NO_COLOR`).
  - Tests in `panel.test.ts` and a new `batch-panel.test.ts`: selection toggles and persists via the constructor; instruction `p` is gone; calibration `p` remains; the batch view renders numbers, comments, summary, and diffs; stale drafts disable Apply.
- [x] **8. Command wiring (`index.ts`).**
  - Add batch actions, the integration modal with cancellation, the Apply confirmation, and recovery entry.
  - Tests in `index.test.ts`, using injected integrate and apply functions:
    - The full flow is select → comment → integrate → regenerate → apply.
    - Each lifecycle event aborts integration without writes.
    - Reject behavior and the calibration trigger after rejection are unchanged.
    - Existing refresh tests are limited to calibration.
- [x] **9. Docs and release.**
  - Update the README for the review flow, batches, write scope, concurrency, and `.gitignore` guidance for `batches/`.
  - Revise `.changeset/idle-learn-review-recovery.md`, or add a batch changeset; it stays minor.
  - Mark `docs/plans/idle-learn-review-recovery.md` per-session locking as superseded.
  - Assert in `package.test.ts` that `files` includes `integration-prompt.md` and excludes tests.
- [x] **10. Verify.**
  - Run `npm ci`, `npm run check` (typecheck, all tests, pack), `npx changeset status`, and `git diff --check`.
  - Confirm the packed tarball contains `integration-prompt.md`, `batch.ts`, `integrate.ts`, and `scope.ts`, and no tests.
  - Confirm that no real `.pi/idle-learn` artifacts in this repository changed.

## Out of scope

- Worker SDK packaging (`fix-idle-worker-host-loader`) and the temporary installed dependencies.
- Calibration redesign, and automatic reorganization outside a user-started batch.
- Publishing or installing.
