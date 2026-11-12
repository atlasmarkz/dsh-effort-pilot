/**
 * Stateful orchestrator: folds the session event log into a per-session
 * picture (current selection, tool rounds, manual overrides) and applies the
 * pure policy from policy.js by writing a `model/selection` event.
 *
 * Why `model/selection` and not an `agent/request` hook: on the DSH lines this
 * plugin targets, `agent/request` listeners may change sampling controls but
 * get rejected if they change provider/model/reasoningEffort ("step
 * preparation fixed ..."). A written selection is read by the *next* step's
 * preparation, which is exactly the semantics a per-step pilot wants, and it
 * never changes the model — so the prompt prefix (and its upstream cache)
 * survives.
 *
 * The plugin has no harness imports by design; everything it needs arrives
 * through the four methods it calls on a Session: `id`, `snapshotEvents()`,
 * `append(type, data)` and (optionally) `requestHeader()`.
 */
import { clampLevel, levelRank, normalizeEfforts, payloadBytes, shiftLevel } from './levels.js';
import { decideEffort } from './policy.js';

/** How many finished tool rounds to retain per session (memory bound). */
const RETAINED_ROUNDS = 8;

/**
 * Stable key for one model selection payload.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
 * @returns {string}
 */
function selectionKey(selection) {
  return JSON.stringify({
    provider: selection?.provider,
    model: selection?.model,
    reasoningEffort: selection?.reasoningEffort,
  });
}

/**
 * Build one scheduler instance.
 *
 * @param {object} options
 * @param {object} options.config normalized deployment config
 * @param {(provider: string, model: string) => Promise<unknown>} options.resolveEfforts
 *   resolves the adapter-owned model metadata (expects `reasoning.efforts`)
 * @param {(message: string) => void} [options.log] verbose logger
 * @returns {object} scheduler API (`observe`, `setLevel`, `status`, `forget`, `refreshEfforts`)
 */
export function createScheduler({ config, resolveEfforts, log = () => {} }) {
  /** @type {Map<string, ReturnType<typeof createState>>} */
  const sessions = new Map();
  /** @type {Map<string, string[]>} ranked declared levels per route */
  const effortCache = new Map();
  /** @type {Map<string, Promise<string[]>>} in-flight metadata lookups */
  const effortInflight = new Map();

  /**
   * Fresh per-session bookkeeping.
   * @returns {object}
   */
  function createState() {
    return {
      selection: undefined,
      oursKey: undefined,
      manual: false,
      autoChanges: 0,
      simpleStreak: 0,
      pendingCalls: new Map(),
      rounds: new Map(),
      lastStep: undefined,
      evalQueued: false,
      hydrated: false,
      foldedSeq: -1,
      holdRemaining: 0,
      pendingEscalation: undefined,
      decisions: [],
    };
  }

  /**
   * State for one session, hydrated from the existing log on first sight.
   * @param {object} session
   * @returns {object}
   */
  function stateFor(session) {
    let state = sessions.get(session.id);
    if (state === undefined) {
      state = createState();
      sessions.set(session.id, state);
      hydrate(session, state);
    }
    return state;
  }

  /**
   * Fold the existing log once so a plugin mounted into a live session starts
   * from the real selection instead of guessing. Historical selections never
   * count as manual overrides.
   * @param {object} session
   * @param {object} state
   */
  function hydrate(session, state) {
    let events = [];
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    } catch (error) {
      log(`could not read existing session log: ${messageOf(error)}`);
    }
    for (const event of events) applyEvent(session, state, event, { silent: true });
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    state.foldedSeq = Number.isInteger(last?.seq) ? last.seq : events.length - 1;
    state.hydrated = true;
    if (state.selection !== undefined) void refreshEfforts(state.selection.provider, state.selection.model);
  }

  /**
   * Fold one session event into the per-session picture.
   * @param {object} session
   * @param {object} state
   * @param {object} event
   * @param {{ silent?: boolean }} [options]
   */
  function applyEvent(session, state, event, options = {}) {
    const silent = options.silent === true;
    switch (event.type) {
      case 'turn/start': {
        state.autoChanges = 0;
        state.simpleStreak = 0;
        state.holdRemaining = 0;
        state.pendingCalls.clear();
        state.rounds.clear();
        state.lastStep = undefined;
        return;
      }
      case 'turn/end': {
        state.pendingCalls.clear();
        state.rounds.clear();
        // A turn that died at the model-request boundary is the only
        // request-level signal we can attribute to a session from the log.
        // Transport/quota codes are excluded: a rate limit is not a sign that
        // the model needed to think harder. The lift is applied in a microtask
        // so it lands before the next turn's step preparation.
        const reason = event.data?.reason;
        if (reason?.kind === 'error') {
          const code = String(reason.error?.code ?? 'UNKNOWN').toUpperCase();
          if (config.escalateOnTurnError && config.escalateOnCodes.includes(code)) {
            state.pendingEscalation = { code };
            log(`turn failed with ${code}; next turn will start one step deeper`);
            queueMicrotask(() => {
              try {
                escalateAfterTurnError(session, state);
              } catch (error) {
                log(`request-error escalation failed: ${messageOf(error)}`);
              }
            });
          } else {
            log(`turn failed with ${code}; not a depth signal, no escalation`);
          }
        }
        return;
      }
      case 'model/selection': {
        const payload = {
          provider: event.data?.provider,
          model: event.data?.model,
          ...event.data?.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort },
        };
        if (typeof payload.provider !== 'string' || typeof payload.model !== 'string') return;
        const key = selectionKey(payload);
        const previous = state.selection;
        const sameRoute = previous !== undefined
          && previous.provider === payload.provider
          && previous.model === payload.model;
        if (state.oursKey === key) {
          state.oursKey = undefined;
        } else if (!silent && state.hydrated && sameRoute && !state.manual
          && payload.reasoningEffort !== previous.reasoningEffort) {
          // Same route, different depth, and not our own write: a human (or
          // another plugin) chose this. Respect it until the model hands
          // control back with `set_effort { level: "auto" }`.
          state.manual = true;
          log(`manual effort override detected (${payload.reasoningEffort ?? 'adapter default'}); automatic scheduling paused for this session`);
        } else if (!silent && !sameRoute) {
          // A model/route switch is not an effort override: adapt to the new
          // ladder and keep piloting.
          state.manual = false;
          state.autoChanges = 0;
          state.simpleStreak = 0;
          state.pendingCalls.clear();
          state.rounds.clear();
          state.lastStep = undefined;
        }
        state.selection = payload;
        void refreshEfforts(payload.provider, payload.model);
        return;
      }
      case 'request/header': {
        if (state.selection !== undefined) return;
        const config = event.data?.header?.config;
        if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return;
        state.selection = {
          provider: config.provider,
          model: config.model,
          ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
        };
        return;
      }
      case 'tool/call': {
        const callId = event.data?.callId;
        if (typeof callId !== 'string') return;
        state.pendingCalls.set(callId, {
          name: event.data?.name,
          bytes: payloadBytes(event.data?.arguments),
        });
        return;
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId;
        if (typeof callId !== 'string') return;
        const call = state.pendingCalls.get(callId);
        if (call === undefined) return;
        state.pendingCalls.delete(callId);
        const step = event.data?.step;
        if (!Number.isFinite(step)) return;
        const round = state.rounds.get(step) ?? [];
        round.push({
          name: call.name,
          bytes: call.bytes,
          failed: event.data?.message?.isError === true || event.data?.error !== undefined,
        });
        state.rounds.set(step, round);
        state.lastStep = step;
        trimRounds(state);
        scheduleEvaluation(session, state);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Keep the per-session round map bounded.
   * @param {object} state
   */
  function trimRounds(state) {
    while (state.rounds.size > RETAINED_ROUNDS) {
      const oldest = state.rounds.keys().next().value;
      state.rounds.delete(oldest);
    }
  }

  /**
   * Coalesce evaluations: one microtask per tool-round burst. The next step's
   * preparation runs after this microtask in practice; if a host ordering
   * change ever makes it late, the change simply lands on the following step.
   * @param {object} session
   * @param {object} state
   */
  function scheduleEvaluation(session, state) {
    if (state.evalQueued) return;
    state.evalQueued = true;
    queueMicrotask(() => {
      state.evalQueued = false;
      try {
        evaluate(session, state);
      } catch (error) {
        log(`evaluation failed: ${messageOf(error)}`);
      }
    });
  }

  /**
   * Apply the policy synchronously (metadata is pre-resolved and cached).
   * @param {object} session
   * @param {object} state
   */
  function evaluate(session, state) {
    if (!config.enabled || !config.auto || state.manual) return;
    if (state.autoChanges >= config.maxAutoChangesPerTurn) return;
    const selection = state.selection;
    if (selection === undefined || typeof selection.provider !== 'string') return;
    const allowed = effortCache.get(routeKey(selection.provider, selection.model));
    if (allowed === undefined) {
      void refreshEfforts(selection.provider, selection.model);
      return;
    }
    if (allowed.length === 0) return;
    const calls = state.lastStep === undefined ? [] : state.rounds.get(state.lastStep) ?? [];
    if (calls.length === 0) return;
    if (state.holdRemaining > 0) {
      // A recent change holds for the configured number of tool rounds, so a
      // noisy first round cannot immediately undo it.
      state.holdRemaining -= 1;
      return;
    }
    const decision = decideEffort({
      current: selection.reasoningEffort,
      allowed,
      calls,
      state: { simpleStreak: state.simpleStreak },
      config,
    });
    state.simpleStreak = decision.state.simpleStreak;
    if (decision.level === undefined || decision.level === selection.reasoningEffort) return;
    if (decision.reason === 'keep' || decision.reason === 'fresh' || decision.reason === 'no-declared-efforts') return;
    writeSelection(session, state, { ...selection, reasoningEffort: decision.level }, `auto:${decision.reason}`);
    state.autoChanges += 1;
    state.simpleStreak = 0;
    state.holdRemaining = config.holdSteps;
    recordDecision(state, selection.reasoningEffort, decision.level, `auto:${decision.reason}`);
  }

  /**
   * Apply the pending request-error escalation before the next turn's first
   * step. Runs from a microtask so it is never a reentrant append.
   * @param {object} session
   * @param {object} state
   */
  function escalateAfterTurnError(session, state) {
    const pending = state.pendingEscalation;
    if (pending === undefined) return;
    if (!config.enabled || !config.auto || state.manual || !config.escalateOnTurnError) {
      state.pendingEscalation = undefined;
      return;
    }
    const selection = state.selection;
    if (selection === undefined) {
      state.pendingEscalation = undefined;
      return;
    }
    const allowed = effortCache.get(routeKey(selection.provider, selection.model));
    if (allowed === undefined) {
      void refreshEfforts(selection.provider, selection.model)
        .then(() => escalateAfterTurnError(session, state))
        .catch(() => {});
      return;
    }
    state.pendingEscalation = undefined;
    if (allowed.length === 0) return;
    if (state.autoChanges >= config.maxAutoChangesPerTurn) return;
    const lifted = shiftLevel(selection.reasoningEffort, allowed, 1);
    if (lifted === selection.reasoningEffort) return;
    writeSelection(session, state, { ...selection, reasoningEffort: lifted }, `request-error:${pending.code}`);
    state.autoChanges += 1;
    state.holdRemaining = config.holdSteps;
    recordDecision(state, selection.reasoningEffort, lifted, `request-error:${pending.code}`);
  }

  /**
   * Append one decision to the bounded per-session ledger.
   * @param {object} state
   * @param {string | undefined} from
   * @param {string} to
   * @param {string} reason
   */
  function recordDecision(state, from, to, reason) {
    state.decisions.push({
      from: from ?? 'default',
      to,
      reason,
    });
    while (state.decisions.length > config.decisionMemory) state.decisions.shift();
  }

  /**
   * Write a selection event and remember it as ours, so the resulting
   * `model/selection` echo is not mistaken for a human override.
   * @param {object} session
   * @param {object} state
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
   * @param {string} origin
   */
  function writeSelection(session, state, selection, origin) {
    const payload = {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    };
    state.oursKey = selectionKey(payload);
    state.selection = payload;
    session.append('model/selection', payload);
    log(`reasoning effort -> ${payload.reasoningEffort ?? 'adapter default'} (${origin})`);
  }

  /**
   * Resolve (and cache) the declared ladder for one route.
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<string[]>} ranked declared levels, or [] when the route is not a reasoning model
   */
  function refreshEfforts(provider, model) {
    if (typeof provider !== 'string' || typeof model !== 'string') return Promise.resolve([]);
    const key = routeKey(provider, model);
    const cached = effortCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = effortInflight.get(key);
    if (inflight !== undefined) return inflight;
    const pending = (async () => {
      try {
        const info = await resolveEfforts(provider, model);
        const levels = normalizeEfforts(info?.reasoning?.efforts);
        effortCache.set(key, levels);
        return levels;
      } catch (error) {
        log(`effort metadata unavailable for ${key}: ${messageOf(error)}`);
        effortCache.set(key, []);
        return [];
      } finally {
        effortInflight.delete(key);
      }
    })();
    effortInflight.set(key, pending);
    return pending;
  }

  /**
   * Agent-facing control: set one declared level, or hand control back to the pilot.
   * @param {object} session
   * @param {string} requested level id or `auto`
   * @param {string} reason audit reason supplied by the model
   * @returns {Promise<{ ok: boolean, level?: string, allowed?: string[], message: string }>}
   */
  async function setLevel(session, requested, reason) {
    const state = stateFor(session);
    const selection = state.selection;
    if (selection === undefined || typeof selection.provider !== 'string') {
      return { ok: false, message: 'No current model selection yet; wait for the first step, then retry.' };
    }
    if (requested === 'auto') {
      state.manual = false;
      log(`agent resumed automatic scheduling (${reason || 'no reason'})`);
      return { ok: true, level: 'auto', message: 'Automatic per-step scheduling resumed for this session.' };
    }
    const allowed = await refreshEfforts(selection.provider, selection.model);
    if (allowed.length === 0) {
      return { ok: false, message: 'This model declares no reasoning efforts; there is nothing to set.' };
    }
    if (!allowed.includes(requested)) {
      const nearest = clampLevel(requested, allowed);
      return {
        ok: false,
        level: nearest,
        allowed,
        message: `"${requested}" is not declared by this model. Declared levels: ${allowed.join(', ')}. Nothing changed; retry with one of them or "auto".`,
      };
    }
    writeSelection(session, state, { ...selection, reasoningEffort: requested }, `agent:${reason || 'no reason'}`);
    state.manual = true;
    state.autoChanges = 0;
    state.holdRemaining = config.holdSteps;
    recordDecision(state, selection.reasoningEffort, requested, `agent:${reason || 'no reason'}`);
    return { ok: true, level: requested, allowed, message: `Thinking effort set to "${requested}" from the next step on. Use "auto" to hand control back to the pilot.` };
  }

  /**
   * Read-only status for the model and for debugging.
   * @param {object} session
   * @returns {object}
   */
  function status(session) {
    const state = stateFor(session);
    const selection = state.selection;
    const allowed = selection === undefined ? [] : effortCache.get(routeKey(selection.provider, selection.model)) ?? [];
    const status = {
      allowed,
      auto: config.enabled && config.auto && !state.manual,
      manual: state.manual,
      autoChangesThisTurn: state.autoChanges,
      holdRemaining: state.holdRemaining,
      lastRoundCalls: state.lastStep === undefined ? 0 : (state.rounds.get(state.lastStep) ?? []).length,
      recentDecisions: state.decisions.map((decision) => ({ ...decision })),
    };
    // Optional fields are omitted when unknown: a tool result must stay
    // lossless JSON, and an explicit `undefined` is rejected by the host.
    if (selection !== undefined) {
      if (typeof selection.provider === 'string') status.provider = selection.provider;
      if (typeof selection.model === 'string') status.model = selection.model;
      if (typeof selection.reasoningEffort === 'string') status.effort = selection.reasoningEffort;
    }
    return status;
  }

  /**
   * Drop a session's bookkeeping (session disposal / test cleanup).
   * @param {string} sessionId
   */
  function forget(sessionId) {
    sessions.delete(sessionId);
  }

  return {
    observe(session, event) {
      if (session === undefined || typeof session?.id !== 'string' || event === undefined) return;
      const state = stateFor(session);
      // The first dispatch that reaches a newly seen session is already inside
      // that session's log (the store appends, then notifies), so hydration has
      // folded it. Do not fold the same event twice.
      if (Number.isInteger(event.seq) && event.seq <= state.foldedSeq) return;
      applyEvent(session, state, event, { silent: false });
      if (Number.isInteger(event.seq)) state.foldedSeq = event.seq;
    },
    setLevel,
    status,
    forget,
    refreshEfforts,
    evaluateForTests(session) {
      const state = stateFor(session);
      evaluate(session, state);
    },
  };
}

/**
 * Route cache key.
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
function routeKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * Message of an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { RETAINED_ROUNDS };
