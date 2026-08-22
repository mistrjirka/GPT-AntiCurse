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
  const CONFIRMED_NON_PRO_LABELS = new Set(["instant", "thinking"]);
  let blockedClicks = 0;
  let blockedUnknownClicks = 0;
  let lastBlockedTurnKey = null;
  let lastBlockedModelSlug = null;
  let lastBlockedDecision = null;
  let lastBlockedDetectionSource = null;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function modelSlugIsPro(value) {
    const slug = normalize(value);
    return slug === "pro" || slug.endsWith("-pro");
  }

  function labelIsPro(value) {
    const label = normalize(value);
    return label === "pro" || label.startsWith("pro thinking") || label.startsWith("pro ");
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

  function proStatusLabelForTurn(turn) {
    if (!turn) return null;
    for (const node of turn.querySelectorAll(`${STREAMING_SELECTOR} .loading-shimmer-tertiary`)) {
      const label = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (labelIsPro(label)) return label;
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

  function activeStreamingTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    }
    return null;
  }

  function activeRecoveryState() {
    const turn = activeStreamingTurn();
    const modelSlug = modelSlugForTurn(turn);
    const proStatusLabel = proStatusLabelForTurn(turn);
    const selectedModelLabel = selectedComposerModelLabel();
    let decision = "unknown";
    let detectionSource = null;

    if (modelSlugIsPro(modelSlug)) {
      decision = "pro";
      detectionSource = "message-model-slug";
    } else if (proStatusLabel) {
      decision = "pro";
      detectionSource = "streaming-pro-status";
    } else if (labelIsPro(selectedModelLabel)) {
      decision = "pro";
      detectionSource = "composer-model-label";
    } else if (modelSlug) {
      decision = "non-pro";
      detectionSource = "message-model-slug";
    } else if (CONFIRMED_NON_PRO_LABELS.has(normalize(selectedModelLabel))) {
      decision = "non-pro";
      detectionSource = "composer-model-label";
    }

    return {
      turn,
      turnKey: turnKey(turn),
      modelSlug,
      proStatusLabel,
      selectedModelLabel,
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

  function block(event, state, phase) {
    blockedClicks++;
    if (state.decision === "unknown") blockedUnknownClicks++;
    lastBlockedTurnKey = state.turnKey || lastBlockedTurnKey;
    lastBlockedModelSlug = state.modelSlug || lastBlockedModelSlug;
    lastBlockedDecision = state.decision || lastBlockedDecision;
    lastBlockedDetectionSource = state.detectionSource || lastBlockedDetectionSource;
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
    // Human clicks must always keep their native behavior. AntiCurse recovery uses
    // HTMLElement.click(), which dispatches an untrusted click.
    if (event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(SUBMIT_SELECTOR);
    if (!button) return;

    const state = activeRecoveryState();
    const stop = button.getAttribute("data-testid") === "stop-button";

    // Fail closed. Automatic recovery is permitted only when the active model is
    // positively identified as non-Pro. ChatGPT has removed data-message-model-slug
    // from some live DOMs, so "unknown" must not silently mean "safe".
    if (stop && !state.autoRecoveryAllowed) {
      block(event, state, "stop");
      return;
    }

    // Defense in depth: block AntiCurse's fixed nudge when the model is Pro or
    // unknown, and after any Stop that this guard already rejected.
    if (!stop && composerContainsOnlyNudge() && (!state.autoRecoveryAllowed ||
        (lastBlockedTurnKey && (!state.turnKey || state.turnKey === lastBlockedTurnKey)))) {
      block(event, state, "send-nudge");
    }
  }, true);

  globalThis.CGAntiCurseProRecoveryGuard = {
    modelSlugIsPro,
    labelIsPro,
    activeProRun: activeRecoveryState,
    activeRecoveryState,
    autoRecoveryAllowed() {
      return activeRecoveryState().autoRecoveryAllowed;
    },
    debug() {
      const state = activeRecoveryState();
      return {
        activeProRun: state.pro,
        activeModelSlug: state.modelSlug,
        activeTurnKey: state.turnKey,
        recoveryDecision: state.decision,
        detectionSource: state.detectionSource,
        proStatusLabel: state.proStatusLabel,
        selectedModelLabel: state.selectedModelLabel,
        autoRecoveryAllowed: state.autoRecoveryAllowed,
        blockedClicks,
        blockedUnknownClicks,
        lastBlockedTurnKey,
        lastBlockedModelSlug,
        lastBlockedDecision,
        lastBlockedDetectionSource
      };
    }
  };
})();
