<p align="center"><img src="assets/logo.svg" width="150" alt="dsh-effort-pilot logo: a three-step thinking-effort ladder next to an autopilot dial"></p>
<h1 align="center">dsh-effort-pilot</h1>

<p align="center"><a href="https://github.com/atlasmarkz/dsh-effort-pilot/releases"><img alt="release" src="https://img.shields.io/github/v/release/atlasmarkz/dsh-effort-pilot"></a> <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4f8cff"></a></p>

> **The money line:** thinking tokens are billed as output. Downgrading 60% of the cheap tool rounds from `max` to `low` saves roughly **30k output tokens** on a 30-step task — about **2¢ per task** on OpenCode Go's DeepSeek V4.1 Flash and **6¢** on V4 Pro.

A per-step **thinking-effort pilot** for DeepSeek Harness (DSH): cheap tool rounds drop a level, failures and heavy work lift one, and the agent can adjust its own depth with `set_effort` — **without ever switching models**, so the prompt prefix and its cache stay intact.

## Install

```bash
dsh plugin --profile web add github:atlasmarkz/dsh-effort-pilot
# or npm: dsh plugin --profile web add dsh-effort-pilot
```

Restart DSH. Zero dependencies, no build step.

## How it decides

| Situation | Action |
|---|---|
| 2 consecutive simple, small tool rounds | lower one level, never below `floor` |
| failed tools, heavy payloads, mixed heavy work | raise one level (or to `high` / `max`) |
| right after a change | hold for `holdSteps` rounds (anti-flapping) |
| last turn ended in `EMPTY_RESPONSE` / `TIMEOUT` etc. | raise one level next turn (rate limit / auth / quota excluded) |
| you picked another level manually | automatic scheduling pauses; `set_effort auto` hands it back |

Only `reasoningEffort` moves; provider/model are copied. Changes apply from the next model step.

## Configuration

Override in your profile's `cordis.patch.yml`:

```yaml
- id: effort-pilot
  config:
    floor: low          # lower bound of automatic downgrades
    simpleStreak: 2     # consecutive simple rounds before one downgrade
    holdSteps: 1        # rounds a fresh change is held
    allowUpgrade: true  # allow failure/heavy-work upgrades
    verbose: false      # log every decision
```

All keys and defaults live in [`lib/config.js`](lib/config.js); unknown keys fail at mount time.

## Tools

- **`set_effort`** — the agent changes its own depth with a mandatory reason; `{ "level": "auto" }` hands control back.
- **`effort_status`** — current level, declared levels, remaining hold, recent decision ledger.

## Cost estimate

30-step task, `max` ~2,500 thinking tokens per step vs `low` ~800, 60% of steps downgraded → ≈ **30,600 output tokens saved**. At OpenCode Go catalog prices: Flash `$0.60/M` ≈ **$0.018/task**, V4 Pro `$1.98/M` ≈ **$0.061/task**; 20 such tasks a day ≈ **$11 / $37 a month**.

Formula: **share of downgraded steps × thinking tokens saved per step × output price**. Calibrate with the host's token stats plus the `effort_status` ledger.

## Development

```bash
node --test   # 40 tests; use node --test --test-isolation=none in restricted sandboxes
```

Extension-point research, rejected alternatives, the full config and the roadmap live in [DESIGN.md](DESIGN.md); the market entry is in [`submission/`](submission/).

MIT
