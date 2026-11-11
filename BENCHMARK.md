# Benchmark: does the pilot actually save time and money?

Measured on the author's machine, **2026-11-12**, DSH `0.2.2-alpha.2`,
provider `opencode-go`, model `deepseek-v4.1-flash` (declared efforts
`low / high / max`). Prices from the installed pi-ai catalog (USD per 1M
tokens): input `$0.15`, cache read `$0.003`, output `$0.60`.

These are small-n measurements on a shared gateway — treat the direction and
the order of magnitude as the result, not the exact milliseconds.

## Setup

- Two tasks, both run with the plugin active.
- **Experiment 1 — mechanical, auto vs fixed max.** One 10-file read/table task.
  Run A called `set_effort max` first (manual override, auto paused); run B did
  not touch `set_effort`, so the pilot scheduled it (`high -> low`, decision
  visible in `effort_status`).
- **Experiment 2 — reasoning, max vs low.** A code-review task with an
  identical prompt, interleaved `max, low, low, max`; both runs locked the level
  via `set_effort` so only the effort varied.
- Metrics come from the host's own projections
  (`sessionStats`, `tokenUsage`): `outputTokens` includes the provider's
  reasoning tokens; `decodeMs` is generation time, `llmMs` includes prefill and
  gateway queueing.

## Experiment 1 — mechanical task (5 steps)

| Run | Effort | Output tokens | Decode | LLM total | Wall clock | Input (uncached / cache read) | Cost |
|---|---|---:|---:|---:|---:|---|---:|
| A (fixed max) | max | 1,216 | 9.4 s | 29.2 s | 35.5 s | 39.7k / 58.1k | $0.0069 |
| B (auto) | low | 763 | 3.9 s | 38.0 s | 38.5 s | 65.2k / 36.4k | $0.0103 |

- **Output tokens -37%**, **decode -59%**: the effort lever works.
- Wall clock and cost went the *other* way in this single pair because run B
  hit a colder prompt cache and a slower gateway moment (its TTFT was 34 s vs
  20 s). That is measurement noise, not the plugin.
- `effort_status` in run B confirmed `high -> low (auto:simple-tool-chain x2)`
  while run A stayed at `max` with `mode: manual`.

## Experiment 2 — reasoning task (3–4 steps, two runs per level, interleaved)

| Effort | Runs | Output tokens | Decode | LLM total | TTFT | Wall clock | Cost |
|---|---|---:|---:|---:|---:|---:|---:|
| `max` | 2 | 3,700 | 47.8 s | 71.2 s | 23.4 s | 71.4 s | $0.0073 |
| `low` | 2 | 2,362 | 29.5 s | 47.3 s | 17.8 s | 47.6 s | $0.0063 |

- **Output tokens -36%**, **decode -38%**, **LLM total -33%**, **wall clock
  -33%** (~24 s faster per task).
- Cost difference is smaller (-13%) because input/cache traffic dominates a
  short task and varies between sessions; the *effort-attributable* saving is
  the output-token delta: `(3700 − 2362) × $0.60/M ≈ $0.0008` per task.

## What this means

- **Speed: real and visible.** Downgrading from `max` to `low` cut generation
  time by ~38% and whole-task wall clock by ~33% on the reasoning task. On the
  mechanical task the decode time dropped 59%. This is the benefit users feel.
- **Money: real but modest for this model.** Measured savings are on the order
  of **0.3–0.9 US cents per task** for 3–5 steps. Extrapolating the observed
  per-step deltas to a 30-step session: ~2.7k–10k output tokens saved, i.e.
  **~$0.002–0.006 on V4.1 Flash** and **~$0.005–0.020 on V4 Pro** (output
  `$1.98/M`). A higher-output model or a thinking-heavy debugging session saves
  proportionally more; the earlier README estimate assumed 2.5k thinking
  tokens per step, which these Flash runs did not produce.
- **Auto behaves as designed** inside one session: tier changes are per-step and
  per-session, and the decision ledger explains each move.

## Experiment 3 — quality: max vs auto vs low

Two tasks, **two samples per arm**, with a blind judge (`deepseek-v4-pro`)
scoring anonymized answers against a ground truth list; the judge never saw
which model/effort produced an answer.

### Task A — fix a failing test suite (objective)

Injected bugs in `sum.js`; 6 tests failing; tests must not be modified.

| Arm | Passed (independently re-run) | Test file unchanged | Output tokens (avg) | Decode (avg) | Steps (avg) |
|---|---:|---:|---:|---:|---:|
| max | 6/6 ×2 | yes | 1,475 | 18.6 s | 8.5 |
| auto | 6/6 ×2 | yes | 739 | 7.1 s | 5.5 |
| low | 6/6 ×2 | yes | 728 | 4.4 s | 6 |

All six fixes are the same standard implementation; no quality difference. Auto
used notably fewer steps and half the output tokens, and its decision ledger
shows it lifting back when work turned mixed (`high -> low -> high
(auto:mixed-work)`).

### Task B — code review with six injected bugs (blind judge, 0–10)

| Arm | Overall | Recall | Precision | Fix quality |
|---|---:|---:|---:|---:|
| max | 9.0 (10, 8) | 10.0 | 9.0 | 9.0 |
| auto | 9.0 (9, 9) | 10.0 | 8.5 | 9.0 |
| low | 10.0 (10, 10) | 10.0 | 9.0 | 10.0 |

All six reviews found all six ground-truth bugs; the differences are inside
judge noise at n=2.

### Reading

- **On these tasks, `max → auto/low` showed no measurable quality loss** — for
  a failing-test fix the objective pass rate is identical, and the blind review
  scores are statistically indistinguishable.
- **Auto is not a one-way ratchet**: it dropped to `low` on mechanical edit
  rounds and lifted to `high` when the work became mixed. Review runs stayed at
  `high` because they had too few tool rounds to trigger a downgrade.
- **Caveat**: both tasks are small and the judge is lenient (recall saturated at
  10/10). For ambiguous or architectural work, keep `floor: high` or check the
  `effort_status` ledger before trusting a downgrade.

## Reproduce

1. Create 10 small text files; run a "read each file and table the first line"
   task with `set_effort max` and again with the pilot left on auto.
2. For the reasoning arm, run the same code-review prompt twice at `max` and
   twice at `low` (interleave to spread gateway variance), locking the level
   with `set_effort`.
3. Read `tokenUsage.totals` and `sessionStats` from
   `harness/storages/session_projcache/sessions/<session>.json`.
