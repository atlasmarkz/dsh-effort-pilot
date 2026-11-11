/**
 * Deployment configuration: plain-object defaults plus strict validation.
 *
 * The plugin deliberately has no runtime dependency on `@deepseek-ai/*`
 * packages (see DESIGN.md), so the config schema is validated by hand rather
 * than with schemastery. Unknown keys fail loud: a silent typo in a profile
 * patch is how "the plugin does nothing" bugs are born.
 */
import { LEVELS, levelRank } from './levels.js';

/** Tool names treated as deterministic, small-payload steps by default. */
const DEFAULT_SIMPLE_TOOLS = Object.freeze([
  'read',
  'read_file',
  'ls',
  'list_dir',
  'grep',
  'search',
  'glob',
  'find',
  'write',
  'write_file',
  'edit',
  'apply_patch',
  'todo_write',
  'job_list',
  'job_output',
  'job_kill',
  'effort_status',
]);

/** Every accepted config key with its default. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch for the automatic pilot. The tools stay available. */
  enabled: true,
  /** Allow automatic per-step scheduling. Off = tools-only. */
  auto: true,
  /** Allow lowering the level on simple tool chains. */
  allowDowngrade: true,
  /** Allow raising the level on failures / heavy work. */
  allowUpgrade: true,
  /** Never drop below this declared level. */
  floor: 'low',
  /** Honored when a mixed/heavy round is not enough for `heavyLevel`. */
  mixedLevel: 'high',
  /** Target of a very heavy tool round. */
  heavyLevel: 'max',
  /** Share of simple calls a round needs before counting as a simple round. */
  simpleRatio: 0.75,
  /** Consecutive simple rounds required before one downgrade step. */
  simpleStreak: 2,
  /** Arguments up to this many bytes count as a small payload. */
  smallPayloadBytes: 8192,
  /** Arguments at or above this many bytes count as a heavy payload. */
  heavyPayloadBytes: 32768,
  /** Safety cap: automatic changes per turn. */
  maxAutoChangesPerTurn: 6,
  /** Tool rounds a fresh change is held before the pilot may change again. */
  holdSteps: 1,
  /** Bounded decision ledger size kept per session. */
  decisionMemory: 8,
  /** Raise one step after a turn that failed at the model-request level. */
  escalateOnTurnError: true,
  /** Failure codes that justify one more thinking step; transport/quota codes are excluded on purpose. */
  escalateOnCodes: ['EMPTY_RESPONSE', 'MALFORMED_RESPONSE', 'SERVER', 'TIMEOUT'],
  /** Tool names counted as simple, deterministic steps. */
  simpleTools: [...DEFAULT_SIMPLE_TOOLS],
  /** Name of the agent-facing control tool. */
  toolName: 'set_effort',
  /** Log every decision to the host console. */
  verbose: false,
});

const BOOLEAN_KEYS = ['enabled', 'auto', 'allowDowngrade', 'allowUpgrade', 'escalateOnTurnError', 'verbose'];
const POSITIVE_INT_KEYS = ['simpleStreak', 'smallPayloadBytes', 'heavyPayloadBytes', 'maxAutoChangesPerTurn', 'decisionMemory'];
const NON_NEGATIVE_INT_KEYS = ['holdSteps'];
const LEVEL_KEYS = ['floor', 'mixedLevel', 'heavyLevel'];
const NUMBER_KEYS = ['simpleRatio'];

/**
 * Validate and normalize a profile-supplied config object.
 * @param {unknown} input raw config from the loader (may be undefined)
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('effort-pilot: config must be an object');

  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_CONFIG));
  if (unknown.length > 0) throw new Error(`effort-pilot: unknown config key(s): ${unknown.join(', ')}`);

  const config = { ...DEFAULT_CONFIG, simpleTools: [...DEFAULT_CONFIG.simpleTools] };

  for (const key of BOOLEAN_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new TypeError(`effort-pilot: config.${key} must be a boolean`);
    config[key] = raw[key];
  }

  for (const key of POSITIVE_INT_KEYS) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) throw new TypeError(`effort-pilot: config.${key} must be a positive integer`);
    config[key] = raw[key];
  }

  for (const key of NON_NEGATIVE_INT_KEYS) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) throw new TypeError(`effort-pilot: config.${key} must be a non-negative integer`);
    config[key] = raw[key];
  }

  for (const key of NUMBER_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] <= 0 || raw[key] > 1) {
      throw new TypeError(`effort-pilot: config.${key} must be a number in (0, 1]`);
    }
    config[key] = raw[key];
  }

  for (const key of LEVEL_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || levelRank(raw[key]) === undefined) {
      throw new TypeError(`effort-pilot: config.${key} must be one of ${LEVELS.join(', ')}`);
    }
    config[key] = raw[key];
  }

  if (raw.escalateOnCodes !== undefined) {
    if (!Array.isArray(raw.escalateOnCodes) || raw.escalateOnCodes.some((code) => typeof code !== 'string' || code.length === 0)) {
      throw new TypeError('effort-pilot: config.escalateOnCodes must be an array of non-empty strings');
    }
    config.escalateOnCodes = [...new Set(raw.escalateOnCodes.map((code) => code.toUpperCase()))];
  }

  if (raw.simpleTools !== undefined) {
    if (!Array.isArray(raw.simpleTools) || raw.simpleTools.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new TypeError('effort-pilot: config.simpleTools must be an array of non-empty strings');
    }
    config.simpleTools = [...new Set(raw.simpleTools.map((name) => name.toLowerCase()))];
  }

  if (raw.toolName !== undefined) {
    if (typeof raw.toolName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(raw.toolName)) {
      throw new TypeError('effort-pilot: config.toolName must match /^[a-z][a-z0-9_]*$/');
    }
    config.toolName = raw.toolName;
  }

  return config;
}
