# Design notes

This document records what was measured in the installed DeepSeek Harness
(`D:\DSH Desktop\resources\app.asar`, DSH `0.2.2-alpha.2`), which extension
points are usable, which were rejected, and why this plugin is shaped the way
it is. It is intentionally factual: if the harness changes, this is the file
to re-check.

## The problem

Reasoning effort dominates latency for agentic coding. DSH re-resolves the
request configuration for every step; a model at `max` effort thinks again
before every tool call, so cheap rounds (read a file, write a file) pay the
same thinking tax as hard rounds. The deployment this plugin was extracted
from runs `opencode-go / deepseek-v4.1-flash / reasoningEffort: max`, where the
adapter declares `low / high / max` only.

Goal: keep the hard reasoning while cutting the cheap-round tax, without
switching models and without an extra decision model.

## Extension points, as measured

| Point | What it actually does on 0.2.2-alpha.2 | Verdict |
|---|---|---|
| `agent/request` waterfall | Listeners may change sampling controls, **not** `provider`/`model`/`reasoningEffort`; the loop throws after step preparation fixed the selection (`use agent.model.select() before step preparation`) | **Rejected** for effort control on this line |
| `agent/pre-step` waterfall | Selection is read *before* the waterfall runs (`this.model.current()`), so a write here applies one step late | Rejected (extra lag) |
| `agent.model.select(selection)` / `session.append('model/selection', …)` | The supported mid-task path. The selection projection feeds the next step's preparation. Effort-only changes do not alter the prompt prefix | **Chosen** |
| `agent/request-error` waterfall | Payload is `{ turn, step, provider, failure, retryPolicy, signal }` — **no session or agent reference**, so a listener cannot attribute the failure to a session reliably | Used indirectly: the same failure is observable as `turn/end { reason.kind: "error" }` in the session log, which *is* attributable |
| `session/event` observer | `(session, event) => …`, dispatched synchronously after every append | Chosen as the read side |
| `tool/call` / `tool/result` events | `tool/call`: `{ callId, name, arguments }`; `tool/result`: `{ turn, step, message: { toolCallId, isError }, error? }` | Chosen as the round signal |
| `ctx.tools.register(definition)` | Accepts a plain definition (name, description, raw JSON Schema `parameters`, `output.schema` + `render`, `execute`, optional `presentCall`) | Chosen for the two tools |
| `llm.resolveModelInfo(provider, model)` | Async; returns `reasoning.efforts` as `[{ id, name }]` | Chosen as the ladder source |
| `systemPrompt.context({ text: fn })` | Dynamic runtime-context contribution; `text` may be a function | Not used yet: a changing runtime-context snapshot appends a new user message and can invalidate the prefix cache, which is exactly what this plugin protects |
| `agent/request-error` waterfall | Recovery extension point used by `dsh-llm-retry` | Not used in v0.1 (roadmap: escalate after request failures) |

Two consequences shaped the code:

1. **No `agent/request` injection.** Plugins written against older DSH lines
   (including popular scheduling plugins) inject effort there. That is now
   rejected, so this plugin does not depend on it.
2. **`model/selection` is the writer.** It is the same mechanism the GUI model
   picker uses (`session.selectModel`), so the Web UI stays in sync for free.

### Why a microtask after `tool/result`

The write must land after the tool batch but before the next step's
preparation. Session observers run synchronously *inside* the append that
triggers them, and appending from inside an append is rejected
(`session append cannot reenter while another append is being published`).
The scheduler therefore queues one microtask per burst; the next step's
preparation is a later job in practice. If a future harness reorders this, the
change simply lands one step later — a graceful degradation, not a stall.

## Invariants

1. **The model route never changes.** `provider` and `model` are copied from
   the current selection; only `reasoningEffort` moves. Switching models is
   out of scope by design because it invalidates the upstream prefix cache.
2. **The session log is the only state.** Selection and tool rounds are folded
   from `session/event`; the in-memory map is decision bookkeeping (streaks,
   caps, manual override) and is rebuilt by hydrating a session's existing log.
3. **Writes are idempotent and attributed.** Every write remembers its
   payload; the resulting `model/selection` echo is recognised as ours and is
   not mistaken for a manual override.
4. **Manual wins.** A same-route effort change that we did not write pauses
   automatic scheduling for the session. Only the model can hand control back
   (`set_effort { level: "auto" }`).
5. **Bounded.** At most `maxAutoChangesPerTurn` automatic changes per turn,
   at most 8 retained tool rounds per session.
6. **Fail soft.** Missing metadata, an unknown route, or an observer error
   never breaks the turn; the pilot just does nothing.

## Policy

Pure function over `(current, allowed, calls, state, config)`:

```text
no ladder                    → keep
no confirmed calls           → keep
failure in the round         → +1 declared step
simple share ≥ ratio
  and max payload ≤ small    → streak + 1; at streak ≥ N → -1 step (≥ floor)
max payload ≥ heavy          → heavyLevel
otherwise                    → mixedLevel when it is above current
default                      → keep
```

`simpleTools` deliberately excludes `bash`/`pwsh`: a shell command is not
deterministic in cost, and a failed command is handled by the escalation rule
instead. The default list is file I/O and small bookkeeping tools.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Inject effort in `agent/request` | rejected by the loop on 0.2.x |
| Do everything in `agent/pre-step` | selection is captured before the waterfall; two-step lag |
| Switch to a smaller/faster model for cheap rounds | breaks the prefix cache, changes answer quality mid-task, and needs routing policy far beyond a pilot |
| Prompt-based self-reminder ("think less") | no effect on the actual `reasoning_effort` parameter, costs tokens |
| A local classifier deciding effort per message | valuable, but a whole extra model + dependency; orthogonal to per-step tool-round scheduling |
| A full model-directory UI takeover (inject an `Auto` level) | the nicest UX, but it pins host internals per rc; planned as a client half after 0.1 stabilises |

## Adjacent project: NVIDIA NeMo Switchyard

[`NVIDIA-NeMo/Switchyard`](https://github.com/NVIDIA-NeMo/Switchyard) (Apache-2.0,
Rust core `libsy`, ~3.5k stars, pre-1.0) solves the **layer above** this plugin:
it routes each request across a *pool of models/providers* (capable vs efficient
tiers, Stage / Escalation / Composite / classifier algorithms) and is embedded in
a gateway or agent harness, preserving OpenAI/Anthropic API compatibility. It is
not a DSH plugin and it does not control reasoning effort.

**Same idea, different layer:** its Stage router also reads recent tool-result
history (severity, spinning, exploring, production intensity) to move turns
between tiers as the agent works. Our pilot reads the same kind of history but
moves only `reasoningEffort` on one fixed model, which keeps the upstream prefix
cache intact; model switching for the same task would cold-start that cache.

**What we borrow:**

- **landed in 0.2:** the hold-after-switch window (`holdSteps`), a bounded
  decision ledger with reasons, and failure-code-gated escalation;
- still roadmap: a confidence band over corroborating signals (instead of one
  hard rule), explicit recovery/progress axes, de-escalation bounds, handoff
  notes on a switch, and a decision-source ledger for observability.

**Why not integrate it here:** Switchyard needs multiple models and credentials,
switches models (cache/quality/billing consequences for a single-subscription
setup), and ships a Rust core rather than a DSH plugin. If both are ever
combined, the natural split is: Switchyard chooses the model tier, this plugin
chooses the depth within the chosen model.

## Request-error escalation is code-filtered on purpose

The `agent/request-error` hook is the natural place to observe failed model
requests, but its payload has no session reference (see the table above), and
not every failure means "the model needed to think harder":

- `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, `SERVER`, `TIMEOUT` — a deeper step
  plausibly helps; eligible;
- `RATE_LIMIT`, `AUTH`, `QUOTA`, `TRANSPORT` — the request never got a fair
  chance; raising effort only spends more tokens on the retry. Excluded.

The signal is therefore read from `turn/end { reason.kind: "error" }`, which
carries the failure code and belongs to a session, and applied in a microtask so
it lands before the next turn's step preparation. It is one-shot per failed turn
and still respects the manual override, the per-turn cap and the hold window.

## Compatibility

- Written against the DSH `0.2.x` plugin surface: named exports
  (`name`, `inject`, `apply`), `ctx.on`, `ctx.tools.register`, plain-object
  config (no `@deepseek-ai/*` imports, no schemastery).
- Zero runtime dependencies, no build step — install works from npm, a local
  path or a GitHub tarball.
- No client half yet, so it is Web/desktop agnostic.

## Roadmap

- **v0.2 — shipped:** hold-after-switch window, failure-code-gated escalation
  from the session log, bounded decision ledger in `effort_status`, and a
  schema-contract regression test for tool outputs.
- v0.3: per-subagent policy switch; confidence band over corroborating signals
  (Switchyard-style scoring) replacing the single hard rules; client half
  (settings page + a session chip showing the live level and last decision, and
  an optional `Auto` entry in the model picker).
- v0.4: optional classifier mode (opt-in, local model) for message-level
  starting depth; metrics (TTFT / tok-s deltas) written to a local ledger;
  handoff notes attached to a switch.

## Testing strategy

- `lib/policy.js` is pure and exhaustively unit-tested (rules, ordering,
  flooring, upgrade toggles).
- `lib/scheduler.js` is tested against a fake Session that implements only the
  four methods the real Session provides; the fake dispatches writes back to
  `observer`, so own-write echo handling is covered.
- `lib/index.js` is tested by mounting it on a fake host context: registration,
  tool execution, status output, config rejection, and a schema-contract check
  that every tool output stays inside its declared `output.schema`.
- `node --test` spawns per-file workers; use `--test-isolation=none` in
  sandboxes that forbid child processes.
