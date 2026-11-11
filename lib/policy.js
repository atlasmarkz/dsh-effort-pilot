/**
 * Pure effort policy: given one completed tool round, the current level, the
 * model-declared ladder and the deployment config, decide the level for the
 * next model step.
 *
 * Kept free of harness imports so the whole decision is unit-testable. The
 * inspiration, credited in DESIGN.md: dsh-tool-turbo and dsh-thinking-levels
 * (simple-tool-round scheduling), dsh-router-laya and dsh-effort-dial
 * (failure escalation), dsh-set-model (agent-visible control).
 */
import { clampLevel, isSimpleTool, levelRank, normalizeEfforts, shiftLevel } from './levels.js';

/**
 * Summarize the confirmed calls of one tool round.
 * @param {Array<{ name: string, bytes?: number, failed?: boolean }>} calls
 * @returns {{ count: number, simpleCount: number, failedCount: number, maxBytes: number, totalBytes: number, allSimple: boolean }}
 */
export function summarizeCalls(calls, config) {
  const list = Array.isArray(calls) ? calls : [];
  let simpleCount = 0;
  let failedCount = 0;
  let maxBytes = 0;
  let totalBytes = 0;
  for (const call of list) {
    if (isSimpleTool(call?.name, config)) simpleCount += 1;
    if (call?.failed === true) failedCount += 1;
    const bytes = typeof call?.bytes === 'number' && Number.isFinite(call.bytes) ? call.bytes : 0;
    maxBytes = Math.max(maxBytes, bytes);
    totalBytes += bytes;
  }
  return {
    count: list.length,
    simpleCount,
    failedCount,
    maxBytes,
    totalBytes,
    allSimple: list.length > 0 && simpleCount === list.length,
  };
}

/**
 * Decide the next step's reasoning effort.
 *
 * Rules, in priority order:
 * 1. No declared ladder (non-reasoning model, unknown route): never touch it.
 * 2. No confirmed tool calls this round (fresh prompt, pure chat): keep.
 * 3. Any failed tool call: lift one declared step (unless the top is reached).
 * 4. A run of simple, small tool rounds: drop one step, but never below `floor`.
 * 5. Very heavy payloads: lift to `heavyLevel`; mixed/heavy work: lift to
 *    `mixedLevel`. Both only when `allowUpgrade` is on.
 * 6. Otherwise keep the current level.
 *
 * @param {object} input
 * @param {string | undefined} input.current current reasoning effort
 * @param {string[]} input.allowed model-declared, ranked levels
 * @param {Array<{ name: string, bytes?: number, failed?: boolean }>} input.calls confirmed calls of the round
 * @param {{ simpleStreak?: number }} [input.state] previous scheduler state
 * @param {object} input.config normalized deployment config
 * @returns {{ level: string | undefined, reason: string, state: { simpleStreak: number } }}
 */
export function decideEffort({ current, allowed, calls, state, config }) {
  const levels = normalizeEfforts(allowed);
  const nextState = { simpleStreak: Math.max(0, Number(state?.simpleStreak) || 0) };

  if (levels.length === 0) return { level: current, reason: 'no-declared-efforts', state: nextState };
  if (typeof current !== 'string' || levelRank(current) === undefined) {
    return { level: clampLevel(current, levels), reason: 'normalize-current', state: nextState };
  }

  const summary = summarizeCalls(calls, config);
  if (summary.count === 0) return { level: current, reason: 'fresh', state: nextState };

  if (summary.failedCount > 0) {
    nextState.simpleStreak = 0;
    if (!config.allowUpgrade) return { level: current, reason: `tool-failure:${summary.failedCount} (upgrade disabled)`, state: nextState };
    return { level: shiftLevel(current, levels, 1), reason: `tool-failure:${summary.failedCount}`, state: nextState };
  }

  const simpleShare = summary.simpleCount / summary.count;
  if (
    config.allowDowngrade
    && simpleShare >= config.simpleRatio
    && summary.maxBytes <= config.smallPayloadBytes
  ) {
    nextState.simpleStreak += 1;
    if (nextState.simpleStreak >= config.simpleStreak) {
      const lowered = shiftLevel(current, levels, -1, config.floor);
      return {
        level: lowered,
        reason: `simple-tool-chain x${nextState.simpleStreak}`,
        state: { simpleStreak: 0 },
      };
    }
    return {
      level: current,
      reason: `simple-tool-chain pending ${nextState.simpleStreak}/${config.simpleStreak}`,
      state: nextState,
    };
  }

  nextState.simpleStreak = 0;
  const currentRank = levelRank(clampLevel(current, levels));
  if (config.allowUpgrade && summary.maxBytes >= config.heavyPayloadBytes) {
    const target = clampLevel(config.heavyLevel, levels);
    if (levelRank(target) > currentRank) {
      return { level: target, reason: `heavy-payload:${summary.maxBytes}`, state: nextState };
    }
  }
  const mixedTarget = clampLevel(config.mixedLevel, levels);
  if (config.allowUpgrade && levelRank(mixedTarget) > currentRank) {
    return { level: mixedTarget, reason: 'mixed-work', state: nextState };
  }

  return { level: current, reason: 'keep', state: nextState };
}
