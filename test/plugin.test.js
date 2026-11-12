import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../lib/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal host context: the plugin only uses `on`, `tools.register` and `llm`. */
function fakeCtx() {
  const listeners = [];
  const registered = [];
  return {
    listeners,
    registered,
    on(event, fn) {
      if (event === 'session/event') listeners.push(fn);
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    llm: {
      async resolveModelInfo() {
        return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } };
      },
    },
  };
}

/** Session stand-in whose append fans out to the plugin's listener. */
function fakeSession(ctx, id = 's1') {
  const session = {
    id,
    events: [],
    appended: [],
    snapshotEvents() {
      return this.events;
    },
    append(type, data) {
      const event = { type, data: structuredClone(data), seq: this.events.length };
      this.events.push(event);
      this.appended.push(event);
      for (const listener of ctx.listeners) listener(session, event);
      return event;
    },
  };
  const emit = (type, data) => {
    const event = { type, data: structuredClone(data), seq: session.events.length };
    session.events.push(event);
    for (const listener of ctx.listeners) listener(session, event);
    return event;
  };
  return { session, emit };
}

function tool(ctx, toolName) {
  return ctx.registered.find((definition) => definition.name === toolName);
}

test('exports the loader metadata', () => {
  assert.equal(name, 'dsh-effort-pilot');
  assert.deepEqual(inject, ['tools', 'llm']);
});

test('apply registers both tools', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.deepEqual(ctx.registered.map((definition) => definition.name).sort(), ['effort_status', 'set_effort']);
  for (const definition of ctx.registered) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.parameters.type, 'object');
  }
});

test('end to end: simple tool rounds downgrade, the agent can override, status reflects it', async () => {
  const ctx = fakeCtx();
  apply(ctx, { verbose: false });
  const { session, emit } = fakeSession(ctx);

  emit('turn/start', { turn: 1 });
  emit('model/selection', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' });
  await tick();

  emit('tool/call', { callId: 'c1', name: 'read', arguments: '{"path":"a.js"}' });
  emit('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } });
  await tick();

  emit('tool/call', { callId: 'c2', name: 'read', arguments: '{"path":"b.js"}' });
  emit('tool/result', { turn: 1, step: 2, message: { toolCallId: 'c2', isError: false } });
  await tick();

  const changes = session.appended.filter((event) => event.type === 'model/selection');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].data.reasoningEffort, 'high');
  assert.equal(changes[0].data.provider, 'opencode-go');

  const setEffort = tool(ctx, 'set_effort');
  const applied = await setEffort.execute({ level: 'max', reason: 'stuck on a concurrency bug' }, { agent: { session } });
  assert.equal(applied.ok, true);
  assert.equal(session.appended.at(-1).data.reasoningEffort, 'max');

  const status = await tool(ctx, 'effort_status').execute({}, { agent: { session } });
  assert.equal(status.effort, 'max');
  assert.equal(status.manual, true);
  assert.deepEqual(status.allowed, ['low', 'high', 'max']);
});

test('the tools refuse to run outside an agent session', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const setEffort = await tool(ctx, 'set_effort').execute({ level: 'high', reason: 'x' }, {});
  assert.equal(setEffort.ok, false);
  const status = await tool(ctx, 'effort_status').execute({}, {});
  assert.equal(status.auto, false);
});

test('misconfigured plugin fails at mount time', () => {
  const ctx = fakeCtx();
  assert.throws(() => apply(ctx, { simpleStreak: -1 }), /positive integer/);
});

test('declared schemas use raw JSON Schema, not the author DSL', () => {
  const ctx = fakeCtx();
  apply(ctx, {});

  const assertNode = (node, path) => {
    assert.equal(typeof node, 'object', `${path} must be an object`);
    if (node.type === 'object') {
      if (node.required !== undefined) {
        assert.ok(Array.isArray(node.required), `${path}.required must be an array at the object level`);
        for (const key of node.required) {
          assert.ok(node.properties && key in node.properties, `${path}.required lists unknown property "${key}"`);
        }
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) assertNode(child, `${path}.properties.${key}`);
      return;
    }
    // DSH rejects `required` on non-object value schemas: it is author-DSL
    // sugar, not raw JSON Schema. This is what broke the first local boot.
    assert.equal(node.required, undefined, `${path}.required is not allowed on type "${node.type}"`);
    if (node.type === 'array') assertNode(node.items, `${path}.items`);
  };

  for (const definition of ctx.registered) {
    assertNode(definition.parameters, `${definition.name}.parameters`);
    assertNode(definition.output.schema, `${definition.name}.output`);
  }
});

test('effort_status is lossless JSON before an effort is selected', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const { session, emit } = fakeSession(ctx);
  // A route that declares efforts but whose selection is adapter-defaulted:
  // the host rejects tool output containing an explicit `undefined` field.
  emit('request/header', { header: { config: { provider: 'opencode-go', model: 'some-model' } } });
  await tick();

  const value = await tool(ctx, 'effort_status').execute({}, { agent: { session } });
  const assertLossless = (node, path = 'root') => {
    assert.notEqual(node, undefined, `${path} is undefined`);
    if (typeof node === 'number') {
      assert.ok(Number.isFinite(node) && !Object.is(node, -0), `${path} must be a finite non-negative-zero number`);
      return;
    }
    if (Array.isArray(node)) {
      assert.equal(Object.keys(node).length, node.length, `${path} must not be sparse`);
      node.forEach((child, index) => assertLossless(child, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      assert.equal(Object.getPrototypeOf(node), Object.prototype, `${path} must be a plain object`);
      for (const [key, child] of Object.entries(node)) assertLossless(child, `${path}.${key}`);
    }
  };
  assertLossless(value);
  assert.equal('effort' in value, false, 'adapter-default effort must be omitted, not undefined');
});

test('tool outputs never exceed their declared output schema', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const { session, emit } = fakeSession(ctx);
  emit('turn/start', { turn: 1 });
  emit('model/selection', { provider: 'p', model: 'm', reasoningEffort: 'high' });
  await tick();

  for (const definition of ctx.registered) {
    const args = definition.name === 'set_effort' ? { level: 'max', reason: 'schema check' } : {};
    const value = await definition.execute(args, { agent: { session } });
    const properties = Object.keys(definition.output.schema.properties);
    for (const key of Object.keys(value)) {
      assert.ok(properties.includes(key), `${definition.name} returns undeclared field "${key}"`);
    }
    for (const key of definition.output.schema.required ?? []) {
      assert.notEqual(value[key], undefined, `${definition.name} misses required field "${key}"`);
    }
  }
});
