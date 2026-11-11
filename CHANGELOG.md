# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-11-11

### Fixed

- **The plugin failed to load in a real DSH host.** Tool output schemas used the
  author-DSL sugar `required: true` on individual properties; `tools.register`
  takes raw JSON Schema, where `required` is an object-level array, so startup
  failed with `JsonSchemaError: ... schema.properties.ok.required is not
  supported on type "boolean"`. Schemas are now raw JSON Schema, validated in CI
  by a regression test, and verified locally against DSH's own
  `assertSupportedJsonSchema` imported from the installed `app.asar`.

## [0.2.0] - 2026-11-11

### Added

- **Hold window** (`holdSteps`, default `1`): a fresh automatic change is held
  for that many tool rounds, so one noisy round cannot immediately undo a
  decision. Borrowed from Switchyard's hold-after-switch idea.
- **Failure-code escalation** (`escalateOnTurnError` + `escalateOnCodes`): a turn
  that ends in a *depth-related* model-request failure (`EMPTY_RESPONSE`,
  `MALFORMED_RESPONSE`, `SERVER`, `TIMEOUT`) starts the next turn one declared
  step deeper. Transport/quota codes (`RATE_LIMIT`, `AUTH`, `QUOTA`,
  `TRANSPORT`) are deliberately excluded: they are not a sign the model needed
  to think harder.
- **Decision ledger** (`decisionMemory`, default `8`): the last decisions per
  session are kept and exposed by `effort_status` (`from → to (reason)`), so the
  model (and you, via host logs) can see why the depth moved.
- Config validation for the new keys (`holdSteps` allows `0`; `escalateOnCodes`
  is upper-cased and de-duplicated).
- Tests for the new behavior (40 total).

### Fixed

- `effort_status` returned an undeclared `simpleStreak` field while its output
  schema had `additionalProperties: false`; a real host would reject the tool
  output. The status payload now matches its schema exactly, and a regression
  test asserts every tool output stays inside its declared schema.

## [0.1.0] - 2026-11-11

### Added

- Per-step automatic thinking-effort scheduling from the session's own
  `tool/call` / `tool/result` history.
- Downshift after consecutive simple, small tool rounds (configurable ratio,
  streak and floor).
- Upshift after tool failures, heavy payloads and mixed/heavy work
  (configurable targets, `allowUpgrade` toggle).
- `set_effort` agent tool: deliberate mid-task level changes or handing control
  back with `auto`, with a mandatory audit reason and model-declared level
  validation.
- `effort_status` read-only tool.
- Cache-safe writing: only `reasoningEffort` moves; provider/model are copied,
  so the prompt prefix and its upstream cache survive.
- Manual-override detection (same route, different depth) that pauses automatic
  scheduling for the session.
- Per-turn automatic-change cap; hydration from an existing session log.
- Strict config validation that fails at mount time on unknown keys.
- 30 unit tests (`node --test`) covering policy, scheduler and plugin wiring;
  GitHub Actions CI for Node 20/22/24.

### Notes

- Targets the DSH 0.2.x plugin surface where `agent/request` listeners may not
  change provider/model/effort; the pilot writes `model/selection` instead.
- Zero runtime dependencies, no build step.
