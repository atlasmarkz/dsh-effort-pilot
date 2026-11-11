/**
 * Canonical reasoning-effort vocabulary shared by the policy and the tools.
 *
 * DSH adapters declare their own effort ids (pi-ai today exposes
 * `off | minimal | low | medium | high | xhigh | max`), and the model may
 * declare only a subset. This module owns ordering, clamping and neighbouring
 * moves over that subset; nothing here talks to the harness.
 */

/** Ranked effort ids, least to most thinking. */
export const LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Rank one effort id.
 * @param {string} level
 * @returns {number | undefined} rank, or undefined for an unknown id
 */
export function levelRank(level) {
  const index = typeof level === 'string' ? LEVELS.indexOf(level) : -1;
  return index === -1 ? undefined : index;
}

/**
 * Normalize adapter-declared efforts into a ranked, de-duplicated list.
 * Accepts both `['low', 'high']` and `[{ id: 'low' }, ...]` shapes.
 * @param {unknown} efforts
 * @returns {string[]}
 */
export function normalizeEfforts(efforts) {
  const ids = [];
  for (const effort of Array.isArray(efforts) ? efforts : []) {
    const id = typeof effort === 'string' ? effort : effort?.id;
    if (typeof id === 'string' && levelRank(id) !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => levelRank(a) - levelRank(b));
}

/**
 * Nearest declared level to `level`.
 * Ties resolve to the lower level: when in doubt this plugin spends less
 * thinking time, which is its whole point.
 * @param {string | undefined} level
 * @param {string[]} allowed ranked list from {@link normalizeEfforts}
 * @returns {string | undefined}
 */
export function clampLevel(level, allowed) {
  const levels = normalizeEfforts(allowed);
  if (levels.length === 0) return undefined;
  if (levels.includes(level)) return level;
  const target = levelRank(level) ?? levelRank('high');
  let best = levels[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of levels) {
    const distance = Math.abs(levelRank(candidate) - target);
    if (distance < bestDistance || (distance === bestDistance && levelRank(candidate) < levelRank(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Move one declared step up or down.
 * `floor` bounds downward moves only (never below the configured floor).
 * @param {string | undefined} level
 * @param {string[]} allowed ranked list
 * @param {1 | -1} direction
 * @param {string | undefined} floor
 * @returns {string | undefined}
 */
export function shiftLevel(level, allowed, direction, floor) {
  const levels = normalizeEfforts(allowed);
  if (levels.length === 0) return level;
  const clamped = clampLevel(level, levels) ?? levels[0];
  let index = levels.indexOf(clamped);
  if (direction > 0) {
    index = Math.min(levels.length - 1, index + 1);
  } else {
    index = Math.max(0, index - 1);
    if (floor !== undefined) {
      const floorIndex = levels.indexOf(clampLevel(floor, levels));
      if (floorIndex >= 0) index = Math.max(index, floorIndex);
    }
  }
  return levels[index];
}

/**
 * Whether a tool name belongs to the configured "simple, deterministic" set.
 * Matching is exact on the lower-cased tool name.
 * @param {string} name
 * @param {{ simpleTools: string[] }} config
 * @returns {boolean}
 */
export function isSimpleTool(name, config) {
  if (typeof name !== 'string') return false;
  return config.simpleTools.includes(name.toLowerCase());
}

/**
 * Approximate payload size without allocating: the recorded JSON argument
 * text length is a good enough proxy for "small vs heavy tool call".
 * @param {unknown} argumentsText
 * @returns {number}
 */
export function payloadBytes(argumentsText) {
  return typeof argumentsText === 'string' ? argumentsText.length : 0;
}
