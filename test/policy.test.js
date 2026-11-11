import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS,
  clampLevel,
  isSimpleTool,
  levelRank,
  normalizeEfforts,
  payloadBytes,
  shiftLevel,
} from '../lib/levels.js';
import { decideEffort, summarizeCalls } from '../lib/policy.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js';

const config = normalizeConfig({});

test('LEVELS is ranked least to most thinking', () => {
  assert.deepEqual([...LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(levelRank('low') < levelRank('high'));
  assert.equal(levelRank('nope'), undefined);
});

test('normalizeEfforts accepts ids or {id} objects, dedupes and sorts', () => {
  assert.deepEqual(normalizeEfforts([{ id: 'max' }, 'low', { id: 'high' }, 'low', 'bogus']), ['low', 'high', 'max']);
  assert.deepEqual(normalizeEfforts(undefined), []);
});

test('clampLevel picks the nearest declared level, ties to the lower one', () => {
  assert.equal(clampLevel('low', ['low', 'high', 'max']), 'low');
  assert.equal(clampLevel('medium', ['low', 'high', 'max']), 'low');
  assert.equal(clampLevel('xhigh', ['low', 'high', 'max']), 'high');
  assert.equal(clampLevel(undefined, ['low', 'high', 'max']), 'high');
  assert.equal(clampLevel('high', []), undefined);
});

test('shiftLevel moves one declared step and honors the floor', () => {
  const allowed = ['low', 'high', 'max'];
  assert.equal(shiftLevel('high', allowed, 1), 'max');
  assert.equal(shiftLevel('max', allowed, 1), 'max');
  assert.equal(shiftLevel('high', allowed, -1), 'low');
  assert.equal(shiftLevel('high', allowed, -1, 'low'), 'low');
  assert.equal(shiftLevel('max', allowed, -1), 'high');
});

test('summarizeCalls counts simple calls, failures and payload bytes', () => {
  const summary = summarizeCalls([
    { name: 'read', bytes: 10 },
    { name: 'bash', bytes: 40000, failed: true },
  ], config);
  assert.equal(summary.count, 2);
  assert.equal(summary.simpleCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.maxBytes, 40000);
  assert.equal(summary.allSimple, false);
});

test('isSimpleTool and payloadBytes are defensive', () => {
  assert.equal(isSimpleTool('READ', config), true);
  assert.equal(isSimpleTool('write_notes', config), false);
  assert.equal(isSimpleTool(undefined, config), false);
  assert.equal(payloadBytes('{"path":"a"}'), 12);
  assert.equal(payloadBytes(undefined), 0);
});

test('fresh prompt keeps the current level', () => {
  const decision = decideEffort({ current: 'max', allowed: ['low', 'high', 'max'], calls: [], state: {}, config });
  assert.equal(decision.level, 'max');
  assert.equal(decision.reason, 'fresh');
});

test('a run of simple small rounds downgrades one step, not below the floor', () => {
  const first = decideEffort({
    current: 'max', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'read', bytes: 40 }], state: {}, config,
  });
  assert.equal(first.level, 'max');
  assert.equal(first.state.simpleStreak, 1);

  const second = decideEffort({
    current: 'max', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'read', bytes: 40 }], state: first.state, config,
  });
  assert.equal(second.level, 'high');
  assert.equal(second.state.simpleStreak, 0);

  const atFloor = decideEffort({
    current: 'low', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'read', bytes: 40 }], state: { simpleStreak: 1 }, config,
  });
  assert.equal(atFloor.level, 'low');
});

test('a failed tool call lifts one step', () => {
  const decision = decideEffort({
    current: 'high', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'bash', bytes: 100, failed: true }], config,
  });
  assert.equal(decision.level, 'max');
  assert.match(decision.reason, /tool-failure/);
});

test('upgrade-disabled configurations keep the level after a failure', () => {
  const decision = decideEffort({
    current: 'low', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'bash', bytes: 100, failed: true }],
    config: normalizeConfig({ allowUpgrade: false }),
  });
  assert.equal(decision.level, 'low');
  assert.match(decision.reason, /upgrade disabled/);
});

test('heavy payloads lift to heavyLevel and mixed work to mixedLevel', () => {
  const heavy = decideEffort({
    current: 'low', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'bash', bytes: 50000 }], config,
  });
  assert.equal(heavy.level, 'max');

  const mixed = decideEffort({
    current: 'low', allowed: ['low', 'high', 'max'],
    calls: [{ name: 'bash', bytes: 200 }], config,
  });
  assert.equal(mixed.level, 'high');
});

test('a non-reasoning route is never touched', () => {
  const decision = decideEffort({
    current: 'max', allowed: [], calls: [{ name: 'read', bytes: 1 }], config,
  });
  assert.equal(decision.level, 'max');
  assert.equal(decision.reason, 'no-declared-efforts');
});

test('the default simple-tool set deliberately excludes shell tools', () => {
  assert.ok(DEFAULT_CONFIG.simpleTools.includes('read'));
  assert.ok(!DEFAULT_CONFIG.simpleTools.includes('bash'));
  assert.ok(!DEFAULT_CONFIG.simpleTools.includes('pwsh'));
});

test('config rejects unknown keys and out-of-range values', () => {
  assert.throws(() => normalizeConfig({ nope: true }), /unknown config key/);
  assert.throws(() => normalizeConfig({ simpleStreak: 0 }), /positive integer/);
  assert.throws(() => normalizeConfig({ simpleRatio: 2 }), /number in \(0, 1\]/);
  assert.throws(() => normalizeConfig({ floor: 'ultra' }), /must be one of/);
  assert.throws(() => normalizeConfig({ toolName: 'Set-Effort' }), /toolName/);
});

test('config merges defaults and normalizes simpleTools casing', () => {
  const merged = normalizeConfig({ verbose: true, simpleTools: ['Read', 'read', 'Grep'] });
  assert.equal(merged.verbose, true);
  assert.deepEqual(merged.simpleTools, ['read', 'grep']);
  assert.equal(merged.auto, DEFAULT_CONFIG.auto);
});
