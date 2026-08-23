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

  function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function modelSlugIsPro(value) { const slug = normalize(value); return slug === "pro" || slug.endsWith("-pro"); }
  function labelIsPro(value) {
    const label = normalize(value);
    if (!label) return false;
    return /(^|[\s(/_\-])pro(?=$|[\s).,/:;!?_\-])/.test(label);
  }
  function streamingLabelIsPro(value) {
    const label = normalize(value);
    if (!label) return false;
    return label === "pro" || label === "pro thinking" || label.startsWith("pro thinking ") || /^model\s+pro(?:\s|$)/.test(label);
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.matches('[data-testid^="conversation-turn-"]') ? turn : turn.querySelector('[data-testid^="conversation-turn-"]');
    return (section && (section.getAttribute("data-turn-id") || section.getAttribute("data-testid"))) || turn.getAttribute("data-turn-id-container") || null;
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

  function decodeJsString(value) { try { return JSON.parse(`"${value}"`); } catch { return String(value || ""); } }
  function rememberPresetLane(map, label, lane) {
    const key = normalize(label);
    if (!key || !PRESET_LANES.has(lane)) return;
    const previous = map.get(key);
    if (!previous) map.set(key, lane); else if (previous !== lane) map.set(key, "ambiguous");
  }
  function buildPresetLaneMap() {
    const scripts = document.scripts || [];
    if (presetLaneCacheBuilt && presetLaneCacheScriptCount === scripts.length) return presetLaneCache;
    const next = new Map();
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
    let resolved = null;
    let bestLength = -1;
    for (const [candidate, lane] of map) {
      if (!PRESET_LANES.has(lane) || candidate.length <= bestLength) continue;
      if (key !== candidate && !key.endsWith(` ${candidate}`) && !key.endsWith(` · ${candidate}`)) continue;
      resolved = lane; bestLength = candidate.length;
    }
    return resolved;
  }

  function activeStreamingTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    return null;
  }
  function newestAssistantTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) if (turns[index].querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) return turns[index];
    return null;
  }

  function classifyTurn(turn, { allowStreamingStatus = false, sourcePrefix = "" } = {}) {
    const directModelSlug = modelSlugForTurn(turn);
    const requestModelSlug = requestModelSlugForTurn(turn);
    const proStatusLabel = allowStreamingStatus ? proStatusLabelForTurn(turn) : null;
    const selectedModelLabel = selectedComposerModelLabel();
    const selectedModelLane = selectedComposerModelLane(selectedModelLabel);
    const modelSlug = directModelSlug || requestModelSlug;
    let decision = "unknown";
    let detectionSource = null;
    const source = (name) => sourcePrefix ? `${sourcePrefix}${name}` : name;
    if (modelSlugIsPro(modelSlug)) { decision = "pro"; detectionSource = source(directModelSlug ? "message-model-slug" : "request-model-slug"); }
    else if (proStatusLabel) { decision = "pro"; detectionSource = source("streaming-pro-status"); }
    else if (labelIsPro(selectedModelLabel)) { decision = "pro"; detectionSource = source("composer-model-label"); }
    else if (selectedModelLane === "pro") { decision = "pro"; detectionSource = source("composer-preset-lane"); }
    else if (modelSlug) { decision = "non-pro"; detectionSource = source(directModelSlug ? "message-model-slug" : "request-model-slug"); }
    else if (selectedModelLane === "instant" || selectedModelLane === "thinking") { decision = "non-pro"; detectionSource = source("composer-preset-lane"); }
    else if (CONFIRMED_NON_PRO_LABELS.has(normalize(selectedModelLabel))) { decision = "non-pro"; detectionSource = source("composer-model-label"); }
    return { turn, turnKey: turnKey(turn), modelSlug, directModelSlug, requestModelSlug, proStatusLabel, selectedModelLabel, selectedModelLane, decision, detectionSource, pro: decision === "pro", autoRecoveryAllowed: decision === "non-pro" };
  }

  function completedRecoveryState(expectedTurnKey = null) {
    const turn = newestAssistantTurn();
    const key = turnKey(turn);
    if (!turn || (expectedTurnKey && key !== expectedTurnKey)) {
      const label = selectedComposerModelLabel();
      return { turn, turnKey: key, modelSlug: null, directModelSlug: null, requestModelSlug: null, proStatusLabel: null, selectedModelLabel: label, selectedModelLane: selectedComposerModelLane(label), decision: "unknown", detectionSource: expectedTurnKey && key ? "completed-turn-mismatch" : "completed-turn-unavailable", pro: false, autoRecoveryAllowed: false };
    }
    return classifyTurn(turn, { allowStreamingStatus: false, sourcePrefix: "completed-" });
  }

  function pendingReloadMarker() {
    const reload = globalThis.CGAntiCurseRecoveryReloadState;
    try { return reload && typeof reload.read === "function" ? reload.read() : null; } catch { return null; }
  }

  function activeRecoveryState() {
    const marker = pendingReloadMarker();
    const active = activeStreamingTurn();
    if (marker && marker.turnKey) {
      // During the one reload transaction, only the exact recovered turn is
      // authoritative. Historical stale streaming markers are ignored.
      if (active && turnKey(active) === marker.turnKey) return classifyTurn(active, { allowStreamingStatus: true });
      return completedRecoveryState(marker.turnKey);
    }
    if (active) return classifyTurn(active, { allowStreamingStatus: true });
    return classifyTurn(null, { allowStreamingStatus: false });
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
    allowedRecoveryNudge = null; return null;
  }
  function rememberAllowedStop(state) {
    allowedRecoveryNudge = { at: Date.now(), armedAt: null, turnKey: state.turnKey || null, modelSlug: state.modelSlug || null, selectedModelLabel: state.selectedModelLabel || null, selectedModelLane: state.selectedModelLane || null, decision: state.decision, detectionSource: state.detectionSource };
  }

  function recoveryNudgeState(expectedTurnKey = null) {
    const state = activeRecoveryState();
    if (state.decision === "pro") return state;
    if (state.autoRecoveryAllowed && (!expectedTurnKey || state.turnKey === expectedTurnKey)) return state;
    const handoff = clearExpiredAllowedNudge();
    if (handoff && handoff.decision === "non-pro" && (!expectedTurnKey || handoff.turnKey === expectedTurnKey)) {
      if (!(state.selectedModelLabel && handoff.selectedModelLabel && normalize(state.selectedModelLabel) !== normalize(handoff.selectedModelLabel))) {
        return { ...state, turnKey: handoff.turnKey || state.turnKey, modelSlug: handoff.modelSlug || state.modelSlug, decision: "non-pro", detectionSource: "approved-stop-handoff", pro: false, autoRecoveryAllowed: true };
      }
    }
    const completed = completedRecoveryState(expectedTurnKey);
    if (completed.decision === "pro" || completed.autoRecoveryAllowed) return completed;
    return state;
  }

  function armRecoveryNudge(expectedTurnKey = null) {
    const state = recoveryNudgeState(expectedTurnKey);
    if (!state.autoRecoveryAllowed) return state;
    let handoff = clearExpiredAllowedNudge();
    if (!handoff || (expectedTurnKey && handoff.turnKey !== expectedTurnKey)) { rememberAllowedStop(state); handoff = clearExpiredAllowedNudge(); }
    if (handoff && (!expectedTurnKey || handoff.turnKey === expectedTurnKey)) handoff.armedAt = Date.now();
    return state;
  }

  function block(event, state, phase) {
    blockedClicks++;
    if (state.decision === "unknown") blockedUnknownClicks++;
    lastBlockedTurnKey = state.turnKey || lastBlockedTurnKey;
    lastBlockedModelSlug = state.modelSlug || lastBlockedModelSlug;
    lastBlockedDecision = state.decision || lastBlockedDecision;
    lastBlockedDetectionSource = state.detectionSource || lastBlockedDetectionSource;
    allowedRecoveryNudge = null;
    event.preventDefault(); event.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent(BLOCK_EVENT, { detail: { phase, turnKey: state.turnKey || null, modelSlug: state.modelSlug || null, decision: state.decision, detectionSource: state.detectionSource, proStatusLabel: state.proStatusLabel || null, selectedModelLabel: state.selectedModelLabel || null } }));
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(SUBMIT_SELECTOR);
    if (!button) return;
    if (event.isTrusted) { allowedRecoveryNudge = null; return; }
    const state = activeRecoveryState();
    const stop = button.getAttribute("data-testid") === "stop-button";
    if (stop) {
      if (!state.autoRecoveryAllowed) { block(event, state, "stop"); return; }
      rememberAllowedStop(state); return;
    }
    if (!composerContainsOnlyNudge()) return;
    const allowedNudge = clearExpiredAllowedNudge();
    if (state.autoRecoveryAllowed) { allowedRecoveryNudge = null; return; }
    if (state.decision === "pro") { block(event, state, "send-nudge"); return; }
    if (allowedNudge && allowedNudge.armedAt && Date.now() - allowedNudge.armedAt <= NUDGE_ARM_WINDOW_MS) { allowedRecoveryNudge = null; return; }
    block(event, state, "send-nudge");
  }, true);

  globalThis.CGAntiCurseProRecoveryGuard = {
    modelSlugIsPro,
    labelIsPro,
    activeProRun: activeRecoveryState,
    activeRecoveryState,
    completedRecoveryState,
    recoveryNudgeState,
    armRecoveryNudge,
    autoRecoveryAllowed() { return activeRecoveryState().autoRecoveryAllowed; },
    debug() {
      const state = activeRecoveryState();
      const completed = completedRecoveryState();
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
        completedTurnKey: completed.turnKey,
        completedRecoveryDecision: completed.decision,
        completedRecoveryDetectionSource: completed.detectionSource,
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
