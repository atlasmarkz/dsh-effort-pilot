import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../lib/scheduler.js';
import { normalizeConfig } from '../lib/config.js';

/** Adapter-declared ladder used by every test (matches opencode-go deepseek-v4.1-flash). */
const EFFORTS = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Minimal Session stand-in: the scheduler only needs id, snapshotEvents,
 * append and requestHeader. `append` dispatches back to the scheduler the way
 * the real store does, so own-write echoes are exercised.
 */
function harness(options = {}) {
  const config = normalizeConfig(options.config ?? {});
  const scheduler = createScheduler({ config, resolveEfforts: async () => EFFORTS });
  const session = {
    id: options.id ?? 's1',
    events: [],
    appended: [],
    snapshotEvents() {
      return this.events;
    },
    requestHeader() {
      return undefined;
    },
    append(type, data) {
      const event = { type, data: structuredClone(data), seq: this.events.length };
      this.events.push(event);
      this.appended.push(event);
      scheduler.observe(this, event);
      return event;
    },
  };
  const emit = (type, data) => {
    const event = { type, data: structuredClone(data), seq: session.events.length };
    session.events.push(event);
    scheduler.observe(session, event);
    return event;
  };
  const selections = () => session.appended.filter((event) => event.type === 'model/selection');
  return { config, scheduler, session, emit, selections };
}

function startAt(level) {
  const h = harness();
  h.emit('turn/start', { turn: 1 });
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: level });
  return h;
}

function simpleRound(h, step, callId = `c${step}`) {
  h.emit('tool/call', { callId, name: 'read', arguments: '{"path":"src/a.js"}' });
  h.emit('tool/result', { turn: 1, step, message: { toolCallId: callId, isError: false } });
}

test('two simple rounds downgrade one level, keeping provider and model fixed', async () => {
  const h = startAt('max');
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');

  simpleRound(h, 1);
  await tick();
  assert.equal(h.selections().length, 0, 'one slow round is not enough');

  simpleRound(h, 2);
  await tick();
  const changed = h.selections().at(-1);
  assert.equal(changed.data.reasoningEffort, 'high');
  assert.equal(changed.data.provider, 'opencode-go');
  assert.equal(changed.data.model, 'deepseek-v4.1-flash');
});

test('a failed tool round escalates for the next step', async () => {
  const h = startAt('high');
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
  h.emit('tool/call', { callId: 'boom', name: 'bash', arguments: '{"cmd":"npm test"}' });
  h.emit('tool/result', { turn: 1, step: 1, message: { toolCallId: 'boom', isError: true } });
  await tick();
  assert.equal(h.selections().at(-1).data.reasoningEffort, 'max');
});

test('a same-route manual effort override pauses automatic scheduling', async () => {
  const h = startAt('high');
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  assert.equal(h.scheduler.status(h.session).manual, true);

  simpleRound(h, 1);
  simpleRound(h, 2);
  await tick();
  assert.equal(h.selections().length, 0, 'manual choice is respected');

  const resumed = await h.scheduler.setLevel(h.session, 'auto', 'hand control back');
  assert.equal(resumed.ok, true);
  assert.equal(h.scheduler.status(h.session).manual, false);
});

test('a route switch adapts instead of counting as a manual override', async () => {
  const h = startAt('high');
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
  const status = h.scheduler.status(h.session);
  assert.equal(status.manual, false);
  assert.equal(status.model, 'deepseek-v4-pro');
});

test('set_effort applies a declared level and rejects undeclared ones', async () => {
  const h = startAt('high');

  const applied = await h.scheduler.setLevel(h.session, 'low', 'mechanical step');
  assert.equal(applied.ok, true);
  assert.equal(h.selections().at(-1).data.reasoningEffort, 'low');
  assert.equal(h.scheduler.status(h.session).manual, true);

  const rejected = await h.scheduler.setLevel(h.session, 'medium', 'try middle');
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.allowed, ['low', 'high', 'max']);
  assert.match(rejected.message, /Declared levels/);
});

test('set_effort works when the selection is still adapter-defaulted', async () => {
  const h = harness();
  h.emit('request/header', { header: { config: { provider: 'p', model: 'm' } } });
  const applied = await h.scheduler.setLevel(h.session, 'high', 'no explicit effort yet');
  assert.equal(applied.ok, true);
  assert.equal(h.selections().at(-1).data.reasoningEffort, 'high');
});

test('automatic changes are capped per turn', async () => {
  const h = harness({ config: { maxAutoChangesPerTurn: 1 } });
  h.emit('turn/start', { turn: 1 });
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');

  simpleRound(h, 1);
  await tick();
  simpleRound(h, 2);
  await tick();
  assert.equal(h.selections().length, 1);

  h.emit('tool/call', { callId: 'fail', name: 'bash', arguments: '{}' });
  h.emit('tool/result', { turn: 1, step: 3, message: { toolCallId: 'fail', isError: true } });
  await tick();
  assert.equal(h.selections().length, 1, 'cap reached for this turn');
});

test('a new turn resets the per-turn change budget', async () => {
  const h = harness({ config: { maxAutoChangesPerTurn: 1 } });
  h.emit('turn/start', { turn: 1 });
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
  simpleRound(h, 1);
  await tick();
  simpleRound(h, 2);
  await tick();
  assert.equal(h.selections().length, 1);

  h.emit('turn/start', { turn: 2 });
  simpleRound(h, 1, 'again');
  await tick();
  simpleRound(h, 2, 'again2');
  await tick();
  assert.equal(h.selections().length, 2);
});

test('a live session is hydrated from its existing log without pausing', async () => {
  const scheduler = createScheduler({ config: normalizeConfig({}), resolveEfforts: async () => EFFORTS });
  const session = {
    id: 'live',
    events: [
      { type: 'turn/start', data: { turn: 1 }, seq: 0 },
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' }, seq: 1 },
    ],
    appended: [],
    snapshotEvents() {
      return this.events;
    },
    append(type, data) {
      const event = { type, data: structuredClone(data), seq: this.events.length };
      this.events.push(event);
      this.appended.push(event);
      scheduler.observe(this, event);
      return event;
    },
  };
  await scheduler.refreshEfforts('p', 'm');
  const status = scheduler.status(session);
  assert.equal(status.effort, 'max');
  assert.equal(status.manual, false);
  assert.deepEqual(status.allowed, ['low', 'high', 'max']);
});

test('status omits unknown optional fields instead of emitting undefined', () => {
  const h = harness();
  h.emit('request/header', { header: { config: { provider: 'p', model: 'm' } } });
  const status = h.scheduler.status(h.session);
  assert.equal('effort' in status, false);
  assert.equal(status.allowed.length, 0);
  for (const value of Object.values(status)) assert.notEqual(value, undefined);
});

test('forget drops a session', () => {
  const h = startAt('high');
  assert.equal(h.scheduler.status(h.session).model, 'deepseek-v4.1-flash');
  h.scheduler.forget('s1');
  assert.equal(h.scheduler.status(h.session).model, 'deepseek-v4.1-flash', 'status re-hydrates lazily');
});

test('a change holds for the configured number of tool rounds', async () => {
  const h = harness({ config: { holdSteps: 1 } });
  h.emit('turn/start', { turn: 1 });
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');

  simpleRound(h, 1);
  await tick();
  simpleRound(h, 2);
  await tick();
  assert.equal(h.selections().length, 1);
  assert.equal(h.selections()[0].data.reasoningEffort, 'high');
  assert.equal(h.scheduler.status(h.session).holdRemaining, 1);

  // Held round: no further change even though the policy would like one.
  simpleRound(h, 3);
  await tick();
  assert.equal(h.selections().length, 1);
  assert.equal(h.scheduler.status(h.session).holdRemaining, 0);

  // Two more simple rounds after the hold can lower again.
  simpleRound(h, 4);
  await tick();
  simpleRound(h, 5);
  await tick();
  assert.equal(h.selections().length, 2);
  assert.equal(h.selections()[1].data.reasoningEffort, 'low');
});

test('a depth-related model-request failure escalates the next turn', async () => {
  const h = startAt('high');
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
  h.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'empty response', code: 'EMPTY_RESPONSE' } } });
  await tick();

  assert.equal(h.selections().length, 1);
  assert.equal(h.selections()[0].data.reasoningEffort, 'max');
  assert.equal(h.selections()[0].data.provider, 'opencode-go');
  const status = h.scheduler.status(h.session);
  assert.equal(status.holdRemaining, 1);
  assert.equal(status.recentDecisions.at(-1).reason, 'request-error:EMPTY_RESPONSE');

  // A new turn does not repeat the one-shot escalation.
  h.emit('turn/start', { turn: 2 });
  await tick();
  assert.equal(h.selections().length, 1);
});

test('transport and quota failure codes are not escalation signals', async () => {
  for (const code of ['RATE_LIMIT', 'AUTH', 'QUOTA', 'TRANSPORT']) {
    const h = startAt('high');
    await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
    h.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code } } });
    await tick();
    assert.equal(h.selections().length, 0, `${code} must not escalate`);
  }
});

test('a manual override blocks request-error escalation too', async () => {
  const h = startAt('high');
  await h.scheduler.refreshEfforts('opencode-go', 'deepseek-v4.1-flash');
  h.emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  h.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'SERVER' } } });
  await tick();
  assert.equal(h.selections().length, 0);
});

test('the decision ledger is bounded and exposed in status', async () => {
  const h = harness({ config: { decisionMemory: 2 } });
  h.emit('turn/start', { turn: 1 });
  h.emit('model/selection', { provider: 'p', model: 'm', reasoningEffort: 'high' });
  await h.scheduler.setLevel(h.session, 'max', 'first');
  await h.scheduler.setLevel(h.session, 'low', 'second');
  await h.scheduler.setLevel(h.session, 'high', 'third');
  const decisions = h.scheduler.status(h.session).recentDecisions;
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((decision) => decision.reason), ['agent:second', 'agent:third']);
  assert.deepEqual(decisions.map((decision) => decision.to), ['low', 'high']);
});
