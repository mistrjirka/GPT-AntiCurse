/* Hard safety gate: AntiCurse must never auto-stop or auto-continue Pro model runs. */
(() => {
  "use strict";

  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const MODEL_SELECTOR = '[data-message-model-slug]';
  const MODEL_TRIGGER_SELECTOR = 'button.__composer-pill [data-animated-slider-trigger="true"]';
  const SUBMIT_SELECTOR = '#composer-submit-button';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  const BLOCK_EVENT = '__gpt_anticurse_pro_recovery_blocked__';
  const CONFIRMED_NON_PRO_LABELS = new Set([
    "instant", "thinking",
    // Capture-backed fallbacks only. Primary classification resolves the
    // localized displayed preset through ChatGPT's own preset -> lane mapping.
    "medium", "high", "extra high",
    "okamžitá", "střední", "vysoká", "velmi vysoká"
  ]);
  const PRESET_LANES = new Set(["instant", "thinking", "pro"]);
  const STOP_HANDOFF_WINDOW_MS = 420_000;
  const NUDGE_ARM_WINDOW_MS = 5_000;
  let presetLaneCache = new Map();
  let presetLaneCacheScriptCount = -1;
  let presetLaneCacheBuilt = false;
  let blockedClicks = 0;
  let blockedUnknownClicks = 0;
  let lastBlockedTurnKey = null;
  let lastBlockedModelSlug = null;
  let lastBlockedDecision = null;
  let lastBlockedDetectionSource = null;
  let allowedRecoveryNudge = null;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function modelSlugIsPro(value) {
    const slug = normalize(value);
    return slug === "pro" || slug.endsWith("-pro");
  }

  function labelIsPro(value) {
    const label = normalize(value);
    if (!label) return false;
    // This is only used on model/intelligence UI or active streaming status, so
    // a standalone Pro token is strong model evidence. It also covers labels
    // such as "GPT-5.6 Pro" without depending on word order or locale.
    return /(^|[\s(/_\-])pro(?=$|[\s).,/:;!?_\-])/.test(label);
  }

  function streamingLabelIsPro(value) {
    const label = normalize(value);
    if (!label) return false;
    // Never treat an arbitrary standalone "pro" token as model evidence. In
    // several locales (including Czech) it is an ordinary preposition and live
    // tool/status text can contain it. Only accept narrowly structured model
    // status labels observed in ChatGPT's streaming UI; all other cases fall
    // back to the explicit model slug or the canonical composer preset lane.
    return label === "pro" || label === "pro thinking" || label.startsWith("pro thinking ") || /^model\s+pro(?:\s|$)/.test(label);
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches('[data-testid^="conversation-turn-"]')
      ? turn
      : turn.querySelector('[data-testid^="conversation-turn-"]');
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) ||
      turn.getAttribute("data-turn-id-container") || null;
  }

  function modelSlugForTurn(turn) {
    if (!turn) return null;
    const nodes = [];
    if (turn.matches && turn.matches(MODEL_SELECTOR)) nodes.push(turn);
    for (const node of turn.querySelectorAll(MODEL_SELECTOR)) nodes.push(node);
    for (let index = nodes.length - 1; index >= 0; index--) {
      const slug = String(nodes[index].getAttribute("data-message-model-slug") || "").trim();
      if (slug) return slug;
    }
    return null;
  }

  function requestModelSlugForTurn(turn) {
    if (!turn) return null;
    // The model slug lives on the user message that launched the active assistant
    // turn. Read only the immediately preceding rendered user turn (skipping
    // virtualization placeholders), never an arbitrary historical turn.
    let container = turn;
    while (container.parentElement?.matches?.(TURN_CONTAINER_SELECTOR)) container = container.parentElement;
    let node = container.previousElementSibling;
    for (let skipped = 0; node && skipped < 8; skipped++, node = node.previousElementSibling) {
      if (!(node instanceof Element) || !node.matches(TURN_CONTAINER_SELECTOR)) continue;
      const user = node.querySelector('[data-message-author-role="user"]');
      const assistant = node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]');
      if (user) {
        const slugNode = user.matches(MODEL_SELECTOR) ? user : user.querySelector(MODEL_SELECTOR);
        return String(slugNode?.getAttribute("data-message-model-slug") || "").trim() || null;
      }
      if (assistant) return null;
      // A placeholder has neither role and can be skipped safely.
    }
    return null;
  }

  function proStatusLabelForTurn(turn) {
    if (!turn) return null;
    for (const node of turn.querySelectorAll(`${STREAMING_SELECTOR} .loading-shimmer-tertiary`)) {
      const label = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (streamingLabelIsPro(label)) return label;
    }
    return null;
  }

  function selectedComposerModelLabel() {
    const nodes = document.querySelectorAll(MODEL_TRIGGER_SELECTOR);
    for (let index = nodes.length - 1; index >= 0; index--) {
      const label = String(nodes[index].textContent || "").replace(/\s+/g, " ").trim();
      if (label) return label;
    }
    return null;
  }

  function decodeJsString(value) {
    try { return JSON.parse(`"${value}"`); } catch { return String(value || ""); }
  }

  function rememberPresetLane(map, label, lane) {
    const key = normalize(label);
    if (!key || !PRESET_LANES.has(lane)) return;
    const previous = map.get(key);
    if (!previous) map.set(key, lane);
    else if (previous !== lane) map.set(key, "ambiguous");
  }

  function buildPresetLaneMap() {
    const scripts = document.scripts || [];
    if (presetLaneCacheBuilt && presetLaneCacheScriptCount === scripts.length) return presetLaneCache;

    const next = new Map();
    // ChatGPT serializes the localized intelligence presets into first-party page
    // bootstrap data. Resolve the visible label back to its canonical lane rather
    // than maintaining a translation list. Keep the parser deliberately narrow:
    // only selected_display_title objects with a recognized lane are accepted.
    const pattern = /selected_display_title:"((?:\\.|[^"\\])*)"[^{}]{0,700}?lane:"(instant|thinking|pro)"/g;
    for (const script of scripts) {
      const text = String(script.textContent || "");
      if (!text.includes("intelligencePresets") || !text.includes("selected_display_title")) continue;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) rememberPresetLane(next, decodeJsString(match[1]), match[2]);
    }
    presetLaneCache = next;
    presetLaneCacheScriptCount = scripts.length;
    presetLaneCacheBuilt = true;
    return presetLaneCache;
  }

  function selectedComposerModelLane(label) {
    const key = normalize(label);
    if (!key) return null;
    const map = buildPresetLaneMap();
    const exact = map.get(key);
    if (PRESET_LANES.has(exact)) return exact;

    // Some layouts may prefix the selected label with a model/version. Use the
    // longest unique mapped label as a suffix fallback and fail closed on conflict.
    let resolved = null;
    let bestLength = -1;
    for (const [candidate, lane] of map) {
      if (!PRESET_LANES.has(lane) || candidate.length <= bestLength) continue;
      if (key !== candidate && !key.endsWith(` ${candidate}`) && !key.endsWith(` · ${candidate}`)) continue;
      resolved = lane;
      bestLength = candidate.length;
    }
    return resolved;
  }

  function activeStreamingTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    }
    return null;
  }

  function activeRecoveryState() {
    const turn = activeStreamingTurn();
    const directModelSlug = modelSlugForTurn(turn);
    const requestModelSlug = requestModelSlugForTurn(turn);
    const proStatusLabel = proStatusLabelForTurn(turn);
    const selectedModelLabel = selectedComposerModelLabel();
    const selectedModelLane = selectedComposerModelLane(selectedModelLabel);
    const modelSlug = directModelSlug || requestModelSlug;
    let decision = "unknown";
    let detectionSource = null;

    // The active request's own model slug is the strongest signal and is
    // language-independent. The preceding-user lookup is deliberately adjacent
    // only, so it cannot accidentally reuse a model from an older request.
    if (modelSlugIsPro(modelSlug)) {
      decision = "pro";
      detectionSource = directModelSlug ? "message-model-slug" : "request-model-slug";
    } else if (proStatusLabel) {
      decision = "pro";
      detectionSource = "streaming-pro-status";
    } else if (labelIsPro(selectedModelLabel)) {
      decision = "pro";
      detectionSource = "composer-model-label";
    } else if (selectedModelLane === "pro") {
      decision = "pro";
      detectionSource = "composer-preset-lane";
    } else if (modelSlug) {
      decision = "non-pro";
      detectionSource = directModelSlug ? "message-model-slug" : "request-model-slug";
    } else if (selectedModelLane === "instant" || selectedModelLane === "thinking") {
      decision = "non-pro";
      detectionSource = "composer-preset-lane";
    } else if (CONFIRMED_NON_PRO_LABELS.has(normalize(selectedModelLabel))) {
      // Current ChatGPT exposes the selected intelligence preset in the composer.
      // These exact labels are capture-backed Thinking/Instant presets; "Pro" is
      // matched above and therefore can never be authorized through this branch.
      decision = "non-pro";
      detectionSource = "composer-model-label";
    }

    return {
      turn,
      turnKey: turnKey(turn),
      modelSlug,
      directModelSlug,
      requestModelSlug,
      proStatusLabel,
      selectedModelLabel,
      selectedModelLane,
      decision,
      detectionSource,
      pro: decision === "pro",
      autoRecoveryAllowed: decision === "non-pro"
    };
  }

  function composerContainsOnlyNudge() {
    const composer = document.querySelector(COMPOSER_SELECTOR);
    return !!composer && String(composer.textContent || "").trim() === ".";
  }

  function clearExpiredAllowedNudge() {
    if (!allowedRecoveryNudge) return null;
    if (Date.now() - allowedRecoveryNudge.at <= STOP_HANDOFF_WINDOW_MS) {
      if (allowedRecoveryNudge.armedAt && Date.now() - allowedRecoveryNudge.armedAt > NUDGE_ARM_WINDOW_MS) allowedRecoveryNudge.armedAt = null;
      return allowedRecoveryNudge;
    }
    allowedRecoveryNudge = null;
    return null;
  }

  function rememberAllowedStop(state) {
    allowedRecoveryNudge = {
      at: Date.now(),
      armedAt: null,
      turnKey: state.turnKey || null,
      modelSlug: state.modelSlug || null,
      selectedModelLabel: state.selectedModelLabel || null,
      selectedModelLane: state.selectedModelLane || null,
      decision: state.decision,
      detectionSource: state.detectionSource
    };
  }

  function recoveryNudgeState(expectedTurnKey = null) {
    const state = activeRecoveryState();
    if (state.decision === "pro" || state.autoRecoveryAllowed) return state;
    const handoff = clearExpiredAllowedNudge();
    if (!handoff || handoff.decision !== "non-pro") return state;
    if (expectedTurnKey && handoff.turnKey !== expectedTurnKey) return state;
    // A model-picker change during a slow Stop invalidates the handoff unless the
    // current UI still positively identifies the model above. Missing composer
    // evidence is allowed because ChatGPT often temporarily unmounts it while
    // cancelling the old request.
    if (state.selectedModelLabel && handoff.selectedModelLabel &&
        normalize(state.selectedModelLabel) !== normalize(handoff.selectedModelLabel)) return state;
    return {
      ...state,
      turnKey: handoff.turnKey || state.turnKey,
      modelSlug: handoff.modelSlug || state.modelSlug,
      decision: "non-pro",
      detectionSource: "approved-stop-handoff",
      pro: false,
      autoRecoveryAllowed: true
    };
  }

  function armRecoveryNudge(expectedTurnKey = null) {
    const state = recoveryNudgeState(expectedTurnKey);
    if (!state.autoRecoveryAllowed) return state;
    const handoff = clearExpiredAllowedNudge();
    if (handoff && (!expectedTurnKey || handoff.turnKey === expectedTurnKey)) handoff.armedAt = Date.now();
    return state;
  }


  function restoreRecoveryHandoff(snapshot) {
    const state = activeRecoveryState();
    if (!snapshot || snapshot.decision !== "non-pro") return state;
    if (state.decision === "pro") return state;
    if (modelSlugIsPro(snapshot.modelSlug)) return state;
    // If ChatGPT exposes a current model selection after reload, it must agree
    // with the selection approved before the guarded recovery reload. Missing UI
    // evidence is allowed because composer controls can hydrate after the thread.
    if (state.selectedModelLabel && snapshot.selectedModelLabel &&
        normalize(state.selectedModelLabel) !== normalize(snapshot.selectedModelLabel)) return state;
    if (state.selectedModelLane === "pro") return state;
    allowedRecoveryNudge = {
      at: Date.now(),
      armedAt: null,
      turnKey: snapshot.turnKey || null,
      modelSlug: snapshot.modelSlug || null,
      selectedModelLabel: snapshot.selectedModelLabel || null,
      selectedModelLane: snapshot.selectedModelLane || null,
      decision: "non-pro",
      detectionSource: snapshot.detectionSource || "recovery-reload"
    };
    return recoveryNudgeState(snapshot.turnKey || null);
  }
  function block(event, state, phase) {
    blockedClicks++;
    if (state.decision === "unknown") blockedUnknownClicks++;
    lastBlockedTurnKey = state.turnKey || lastBlockedTurnKey;
    lastBlockedModelSlug = state.modelSlug || lastBlockedModelSlug;
    lastBlockedDecision = state.decision || lastBlockedDecision;
    lastBlockedDetectionSource = state.detectionSource || lastBlockedDetectionSource;
    allowedRecoveryNudge = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent(BLOCK_EVENT, { detail: {
      phase,
      turnKey: state.turnKey || null,
      modelSlug: state.modelSlug || null,
      decision: state.decision,
      detectionSource: state.detectionSource,
      proStatusLabel: state.proStatusLabel || null,
      selectedModelLabel: state.selectedModelLabel || null
    } }));
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(SUBMIT_SELECTOR);
    if (!button) return;

    // Human clicks must always keep their native behavior. They also cancel any
    // one-shot authorization left by an in-progress automatic recovery.
    if (event.isTrusted) {
      allowedRecoveryNudge = null;
      return;
    }

    const state = activeRecoveryState();
    const stop = button.getAttribute("data-testid") === "stop-button";

    // Fail closed. Automatic recovery is permitted only when the active model is
    // positively identified as non-Pro. ChatGPT has removed data-message-model-slug
    // from some live DOMs, so "unknown" must not silently mean "safe".
    if (stop) {
      if (!state.autoRecoveryAllowed) {
        block(event, state, "stop");
        return;
      }
      // Stop removes ChatGPT's streaming marker before AntiCurse sends its fixed
      // nudge. Carry this positively identified non-Pro decision across that one
      // transition only; do not reinterpret the now-missing turn as safe.
      rememberAllowedStop(state);
      return;
    }

    if (!composerContainsOnlyNudge()) return;

    const allowedNudge = clearExpiredAllowedNudge();
    if (state.autoRecoveryAllowed) {
      allowedRecoveryNudge = null;
      return;
    }
    // An explicit current Pro signal always wins. The one-shot authorization is
    // only for the brief state where Stop removed the streaming marker; it must
    // never authorize a nudge after the user switches the composer to Pro.
    if (state.decision === "pro") {
      block(event, state, "send-nudge");
      return;
    }
    if (allowedNudge && allowedNudge.armedAt && Date.now() - allowedNudge.armedAt <= NUDGE_ARM_WINDOW_MS) {
      // One-shot authorization: the watchdog must arm the previously approved
      // Stop handoff immediately before Send. Consume it before page handlers
      // run so it cannot be reused by a later synthetic click.
      allowedRecoveryNudge = null;
      return;
    }
    block(event, state, "send-nudge");
  }, true);

  globalThis.CGAntiCurseProRecoveryGuard = {
    modelSlugIsPro,
    labelIsPro,
    activeProRun: activeRecoveryState,
    activeRecoveryState,
    recoveryNudgeState,
    armRecoveryNudge,
    restoreRecoveryHandoff,
    autoRecoveryAllowed() {
      return activeRecoveryState().autoRecoveryAllowed;
    },
    debug() {
      const state = activeRecoveryState();
      const allowedNudge = clearExpiredAllowedNudge();
      return {
        activeProRun: state.pro,
        activeModelSlug: state.modelSlug,
        directModelSlug: state.directModelSlug,
        requestModelSlug: state.requestModelSlug,
        activeTurnKey: state.turnKey,
        recoveryDecision: state.decision,
        detectionSource: state.detectionSource,
        proStatusLabel: state.proStatusLabel,
        selectedModelLabel: state.selectedModelLabel,
        selectedModelLane: state.selectedModelLane,
        presetLaneCount: buildPresetLaneMap().size,
        autoRecoveryAllowed: state.autoRecoveryAllowed,
        blockedClicks,
        blockedUnknownClicks,
        lastBlockedTurnKey,
        lastBlockedModelSlug,
        lastBlockedDecision,
        lastBlockedDetectionSource,
        allowedRecoveryNudge: allowedNudge ? {
          turnKey: allowedNudge.turnKey,
          modelSlug: allowedNudge.modelSlug,
          decision: allowedNudge.decision,
          detectionSource: allowedNudge.detectionSource,
          armed: !!allowedNudge.armedAt,
          handoffRemainingMs: Math.max(0, STOP_HANDOFF_WINDOW_MS - (Date.now() - allowedNudge.at)),
          armRemainingMs: allowedNudge.armedAt ? Math.max(0, NUDGE_ARM_WINDOW_MS - (Date.now() - allowedNudge.armedAt)) : 0
        } : null
      };
    }
  };
})();
