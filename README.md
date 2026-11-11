<p align="center"><img src="assets/logo.svg" width="168" alt="dsh-effort-pilot logo: a three-step thinking-effort ladder next to an autopilot dial"></p>
<h1 align="center">dsh-effort-pilot</h1>

<p align="center"><a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4f8cff"></a></p>

Per-step **thinking-effort pilot** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Cheap tool rounds stay cheap, failures escalate, and the model gets a `set_effort` tool — **without ever switching models**, so the prompt prefix and its upstream cache stay intact.

```text
turn:  [user prompt] → step 1 (max)  → read/write ×2 (small) → step 2 (high) → … → failure → step N (max)
                              auto pilot drops one level              auto pilot lifts one level
```

## Why this exists

Reasoning tokens dominate wall-clock time in agentic coding. A `max`-effort model re-thinks before **every** tool call, so a 30-step task can spend minutes in thinking between cheap file reads. Existing plugins solve slices of this:

| Existing plugin | What it takes | Limitation |
|---|---|---|
| `dsh-thinking-levels` / `dsh-tool-turbo` | per-tool-round auto scheduling (simple tools → low) | one is version-pinned, the other GitHub-only with no settings surface |
| `dsh-router-laya`, `@zengevent/dsh-effort-dial` | failure / retry escalation | classifier needs a model, another is UI-only |
| `dsh-set-model` | agent-autonomous model **and** effort switching | switching models invalidates the KV cache; requires an external decision service for auto mode |
| `dsh-turbo` | session-level gears | changes planning/verification policy, not per-step effort |

`dsh-effort-pilot` combines the useful 80%: **automatic per-step scheduling + failure escalation + agent-visible control**, with one hard rule — *the model route never changes*. Only `reasoningEffort` moves, so upstream prefix caching is preserved.

It also deliberately targets the **current** DSH extension surface: on DSH `0.2.x` an `agent/request` listener may no longer change the route or effort (the agent loop throws `use agent.model.select() before step preparation`). The pilot writes `model/selection`, which is the supported, cache-safe path.

## Install

Requirements: DSH ≥ `0.2.0-rc.1` (verified against the `agent/request` guard shipped in 0.2.x). No build step, no runtime dependencies — this is plain ESM.

```bash
# from GitHub
dsh plugin --profile web add github:atlasmarkz/dsh-effort-pilot

# from npm (once published under the same name)
dsh plugin --profile web add dsh-effort-pilot

# from a local checkout (development)
dsh plugin --profile web add /absolute/path/to/dsh-effort-pilot
```

Restart DSH after the first install (bundle layers are composed at boot). Uninstall with `dsh plugin --profile web remove dsh-effort-pilot`.

## How it works

Three cooperative pieces, no harness imports:

1. **Listener** — one `session/event` listener folds the session's own log: current selection, tool calls/results per step, manual overrides. Nothing is duplicated; the session log is the source of truth.
2. **Scheduler** — after a tool round completes it maps the round onto a small pure policy (below) and writes `model/selection` with the **same provider/model** and a new `reasoningEffort`. DSH reads that selection when preparing the next step — which is exactly “mid-task switching”.
3. **Tools** — `set_effort` lets the model change depth (or return to `auto`) with a mandatory audit reason; `effort_status` reports the route, declared ladder and mode.

### Decision rules

| Situation | Action |
|---|---|
| fresh prompt / no tool calls | keep current level |
| ≥75 % simple, small tools for 2 consecutive rounds | lower one declared step, never below `floor` |
| any failed tool call | raise one declared step |
| very heavy tool payload (≥ 32 KB) | raise to `heavyLevel` (`max`) |
| mixed / heavy work | raise to `mixedLevel` (`high`) |
| right after an automatic change | hold for `holdSteps` rounds (anti-flapping) |
| last turn ended in a whitelisted model-request failure | raise one step at the next turn (`RATE_LIMIT` / `AUTH` / `QUOTA` excluded) |
| manual effort choice by you (same route) | pause automatic scheduling for the session |
| route/model change | adapt to the new model's ladder, keep piloting |

A turn is capped at `maxAutoChangesPerTurn` automatic changes, so a pathological loop cannot flap the level; every change lands in the decision ledger that `effort_status` can replay.

## Configuration

Override the same plugin id from your profile's `cordis.patch.yml`:

```yaml
- id: effort-pilot
  config:
    enabled: true
    auto: true
    allowDowngrade: true
    allowUpgrade: true
    floor: low                 # never auto-drop below this declared level
    simpleRatio: 0.75          # share of simple calls that makes a "simple round"
    simpleStreak: 2            # consecutive simple rounds before one downgrade
    smallPayloadBytes: 8192
    heavyPayloadBytes: 32768
    mixedLevel: high
    heavyLevel: max
    maxAutoChangesPerTurn: 6
    holdSteps: 1               # rounds a change is held before another automatic change
    decisionMemory: 8          # per-session decision ledger size
    escalateOnTurnError: true  # depth-related request failure lifts the next turn
    escalateOnCodes: [EMPTY_RESPONSE, MALFORMED_RESPONSE, SERVER, TIMEOUT]
    simpleTools: [read, grep, glob, write, edit, todo_write, job_output]
    toolName: set_effort
    verbose: false
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch for the automatic pilot (tools stay available) |
| `auto` | `true` | per-step scheduling; `false` = tools-only mode |
| `allowDowngrade` / `allowUpgrade` | `true` | permit lowering / raising |
| `floor` | `low` | lower bound of automatic downgrades |
| `mixedLevel` / `heavyLevel` | `high` / `max` | upgrade targets |
| `simpleRatio` / `simpleStreak` | `0.75` / `2` | how quickly simple rounds downgrade |
| `smallPayloadBytes` / `heavyPayloadBytes` | `8192` / `32768` | payload thresholds (argument text length) |
| `maxAutoChangesPerTurn` | `6` | safety cap |
| `holdSteps` | `1` | rounds a fresh change is held before the next automatic change (`0` disables) |
| `decisionMemory` | `8` | per-session decision ledger size |
| `escalateOnTurnError` / `escalateOnCodes` | `true` / see above | lift one step after a depth-related model-request failure; transport/quota codes are excluded |
| `simpleTools` | see above | deterministic tools; shell tools are deliberately excluded |
| `toolName` | `set_effort` | name of the agent-facing tool |
| `verbose` | `false` | print every decision to the host console |

Typo-safe by design: unknown keys fail at mount time instead of silently doing nothing.

### For a `max`-happy setup (e.g. OpenCode Go + DeepSeek V4.1 Flash)

The model declares `low / high / max`. Recommended starting point:

```yaml
- id: effort-pilot
  config:
    floor: low
    simpleStreak: 2
    allowUpgrade: true
```

Run a normal task: simple file-edit loops will drift down to `low`, failures and big refactors pull back to `high`/`max`. If you want a hard boundary, set `floor: high` for “never below high”.

## Tools

### `set_effort`

```json
{ "level": "max", "reason": "concurrent order-loss bug needs deeper reasoning" }
```

Levels are validated against what the current model declares; an unsupported level returns the declared list and changes nothing. `{ "level": "auto" }` hands control back to the pilot. The change applies from the next model step.

### `effort_status`

Returns provider/model, declared levels, current effort, whether the pilot is in auto mode, the turn's change count, the remaining hold rounds, and the recent decision ledger (`from → to (reason)`). Cheap enough to call whenever the model is unsure why the depth moved.

## Behavior notes

- **Changes are step-granular.** DSH fixes the selection when a step is prepared; a pilot decision therefore lands on the next step, never mid-stream.
- **Only effort moves.** The provider/model fields are copied from the current selection; switching models is explicitly out of scope (that is what preserves the cache).
- **Manual choice wins.** Picking a different effort for the same model pauses auto until the model calls `set_effort { level: "auto" }` or the session ends.
- **Subagent sessions** are ordinary sessions; the pilot applies there too. Disable per-profile with `auto: false` if you do not want that.
- **No network, no files, no state beyond the session log** (except in-memory decision bookkeeping).

## Development

```bash
node --test                          # 40 tests: policy, config, scheduler, plugin wiring
node --test --test-isolation=none    # same, in-process (useful in restricted sandboxes)
```

The policy is a pure function; the scheduler is tested against a fake Session implementing `id`, `snapshotEvents()`, `append()` and `requestHeader()`. No DSH installation is needed to run the suite.

See [DESIGN.md](./DESIGN.md) for the extension-point research, rejected alternatives and roadmap.

## Open-sourcing checklist

1. Rename the repo / npm scope if you like; `package.json` has no owner fields on purpose.
2. `npm publish` (two-factor auth may be required; the package is public).
3. Add the GitHub repo URL, CI badge and a screenshot of the settings/dock row once you build a client half.
4. The `cordis.patch.yml` in this package is the bundle layer; do not rename the `id` without a migration note.

## Credits

Inspired by, and standing on the observations of:

- [dsh-tool-turbo](https://github.com/Electricitysheep/dsh-tool-turbo) and [dsh-thinking-levels](https://github.com/drscrewdriver/dsh-thinking-levels) — simple-tool-round scheduling;
- [dsh-router-laya](https://github.com/HapyRain/dsh-router-laya) and [dsh-effort-dial](https://github.com/zengxiaolou/dsh-effort-dial) — failure/retry escalation;
- [dsh-set-model](https://github.com/john-walks-slow/dsh-set-model) — agent-visible control and audit reasons.

## License

MIT
