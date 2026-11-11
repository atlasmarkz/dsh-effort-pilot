/**
 * dsh-effort-pilot — a per-step thinking-effort pilot for DeepSeek Harness.
 *
 * It never switches the model. It writes `model/selection` events that keep
 * the provider/model fixed and move only `reasoningEffort`, so the next step
 * gets the right amount of thinking while the prompt prefix (and its upstream
 * cache) stays intact.
 *
 * Three cooperative parts:
 *  - automatic scheduling from the session's own tool-call history;
 *  - `set_effort`, an agent-facing tool for deliberate mid-task changes;
 *  - `effort_status`, a read-only view of the current ladder and mode.
 *
 * @module dsh-effort-pilot
 */
import { normalizeConfig } from './config.js';
import { LEVELS } from './levels.js';
import { createScheduler } from './scheduler.js';

export const name = 'dsh-effort-pilot';
export const inject = ['tools', 'llm'];

/**
 * Install the pilot on one host context.
 * @param {object} ctx plugin context carrying `tools` and `llm`
 * @param {object} [rawConfig] profile-supplied config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = (message) => {
    if (config.verbose) console.log(`[effort-pilot] ${message}`);
  };

  const scheduler = createScheduler({
    config,
    resolveEfforts: (provider, model) => ctx.llm.resolveModelInfo(provider, model),
    log,
  });

  // One listener for every session. The scheduler hydrates a session's state
  // from its own log the first time it sees it, so mounting into a live
  // session is safe.
  ctx.on('session/event', (session, event) => scheduler.observe(session, event));

  ctx.tools.register(buildSetEffortTool(scheduler, config));
  ctx.tools.register(buildStatusTool(scheduler));
}

/**
 * Shape the agent-facing control tool.
 * Raw JSON Schema is passed straight to the tool registry; this plugin keeps
 * zero runtime dependencies, so it does not use `defineTool` or schemastery.
 * @param {object} scheduler
 * @param {object} config
 * @returns {object}
 */
function buildSetEffortTool(scheduler, config) {
  return {
    name: config.toolName,
    description:
      'Change how much thinking the model spends, without switching models. '
      + 'Use a level this model declares (see effort_status) for deliberate control, or "auto" to hand per-step scheduling back to the pilot. '
      + 'Raise effort when stuck, when a plan is wrong, or when a step needs deeper reasoning; lower it for mechanical steps. '
      + 'The change applies from the next model step. `reason` is required so the switch is auditable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: {
          type: 'string',
          enum: [...LEVELS, 'auto'],
          description: 'Declared reasoning level id, or "auto" to resume automatic scheduling.',
        },
        reason: {
          type: 'string',
          description: 'Short, concrete reason for the change (e.g. "concurrent bug needs deeper reasoning").',
        },
      },
      required: ['level', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message'],
        properties: {
          ok: { type: 'boolean' },
          level: { type: 'string' },
          allowed: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined) return { ok: false, message: 'This tool must run inside an agent session.' };
      const result = await scheduler.setLevel(session, args.level, args.reason);
      return result;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Set thinking effort',
      kind: 'other',
      rawInput: { level: args.level, reason: args.reason },
    }),
  };
}

/**
 * Shape the read-only status tool.
 * @param {object} scheduler
 * @returns {object}
 */
function buildStatusTool(scheduler) {
  return {
    name: 'effort_status',
    description:
      'Report the current provider/model, the reasoning levels it declares, the effort in force, whether the pilot is managing it automatically, '
      + 'and the most recent effort decisions with their reasons. Cheap and safe to call when you are unsure what depth you are running at.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['allowed', 'auto', 'manual', 'autoChangesThisTurn', 'holdRemaining', 'lastRoundCalls', 'recentDecisions'],
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
          allowed: { type: 'array', items: { type: 'string' } },
          auto: { type: 'boolean' },
          manual: { type: 'boolean' },
          autoChangesThisTurn: { type: 'integer' },
          holdRemaining: { type: 'integer' },
          lastRoundCalls: { type: 'integer' },
          recentDecisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'to', 'reason'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `route: ${value.provider ?? '?'}/${value.model ?? '?'}`,
          `effort: ${value.effort ?? 'adapter default'}`,
          `declared levels: ${value.allowed.length > 0 ? value.allowed.join(' / ') : '(none declared)'}`,
          `mode: ${value.auto ? 'auto' : value.manual ? 'manual (agent/model override)' : 'manual (user override)'}`,
          `auto changes this turn: ${value.autoChangesThisTurn} (hold: ${value.holdRemaining} round(s))`,
        ];
        if (value.recentDecisions.length > 0) {
          lines.push('recent decisions:');
          for (const decision of value.recentDecisions) lines.push(`  ${decision.from} -> ${decision.to} (${decision.reason})`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(_args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined) {
        return { allowed: [], auto: false, manual: true, autoChangesThisTurn: 0, holdRemaining: 0, lastRoundCalls: 0, recentDecisions: [] };
      }
      return scheduler.status(session);
    },
    presentCall: () => ({ card: 'generic', title: 'Thinking effort status', kind: 'other', rawInput: {} }),
  };
}
