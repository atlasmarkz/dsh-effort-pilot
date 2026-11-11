import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js';

test('v0.2 defaults: hold, decision ledger and failure-code escalation are on', () => {
  assert.equal(DEFAULT_CONFIG.holdSteps, 1);
  assert.equal(DEFAULT_CONFIG.decisionMemory, 8);
  assert.equal(DEFAULT_CONFIG.escalateOnTurnError, true);
  assert.deepEqual(DEFAULT_CONFIG.escalateOnCodes, ['EMPTY_RESPONSE', 'MALFORMED_RESPONSE', 'SERVER', 'TIMEOUT']);
});

test('holdSteps accepts zero but rejects negatives and fractions', () => {
  assert.equal(normalizeConfig({ holdSteps: 0 }).holdSteps, 0);
  assert.throws(() => normalizeConfig({ holdSteps: -1 }), /non-negative integer/);
  assert.throws(() => normalizeConfig({ holdSteps: 1.5 }), /non-negative integer/);
});

test('escalateOnCodes is normalized to upper case and rejects bad items', () => {
  assert.deepEqual(normalizeConfig({ escalateOnCodes: ['timeout', 'Server'] }).escalateOnCodes, ['TIMEOUT', 'SERVER']);
  assert.throws(() => normalizeConfig({ escalateOnCodes: [''] }), /array of non-empty strings/);
  assert.throws(() => normalizeConfig({ escalateOnCodes: 'TIMEOUT' }), /array of non-empty strings/);
});

test('decisionMemory must be positive and decides the ledger cap', () => {
  assert.equal(normalizeConfig({ decisionMemory: 3 }).decisionMemory, 3);
  assert.throws(() => normalizeConfig({ decisionMemory: 0 }), /positive integer/);
});
