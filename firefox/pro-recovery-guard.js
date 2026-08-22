/* Hard safety gate: AntiCurse must never auto-stop or auto-continue Pro model runs. */
(() => {
  "use strict";

  const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
  const STREAMING_SELECTOR = '[data-streaming-response-status]';
  const MODEL_SELECTOR = '[data-message-model-slug]';
  const SUBMIT_SELECTOR = '#composer-submit-button';
  const COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
  const BLOCK_EVENT = '__gpt_anticurse_pro_recovery_blocked__';
  let blockedClicks = 0;
  let lastBlockedTurnKey = null;
  let lastBlockedModelSlug = null;

  function modelSlugIsPro(value) {
    const slug = String(value || "").trim().toLowerCase();
    return slug === "pro" || slug.endsWith("-pro");
  }

  function turnKey(turn) {
    if (!turn) return null;
    const section = turn.querySelector('[data-testid^="conversation-turn-"]');
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

  function activeStreamingTurn() {
    const turns = document.querySelectorAll(TURN_CONTAINER_SELECTOR);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].querySelector(STREAMING_SELECTOR)) return turns[index];
    }
    return null;
  }

  function activeProRun() {
    const turn = activeStreamingTurn();
    const modelSlug = modelSlugForTurn(turn);
    return {
      turn,
      turnKey: turnKey(turn),
      modelSlug,
      pro: modelSlugIsPro(modelSlug)
    };
  }

  function composerContainsOnlyNudge() {
    const composer = document.querySelector(COMPOSER_SELECTOR);
    return !!composer && String(composer.textContent || "").trim() === ".";
  }

  function block(event, state, phase) {
    blockedClicks++;
    lastBlockedTurnKey = state.turnKey || lastBlockedTurnKey;
    lastBlockedModelSlug = state.modelSlug || lastBlockedModelSlug;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent(BLOCK_EVENT, { detail: {
      phase,
      turnKey: state.turnKey || null,
      modelSlug: state.modelSlug || null
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

    const state = activeProRun();
    const stop = button.getAttribute("data-testid") === "stop-button";
    if (stop && state.pro) {
      block(event, state, "stop");
      return;
    }

    // Defense in depth: if a future recovery implementation attempts to send
    // the fixed AntiCurse nudge without a preceding Stop click, block that too.
    if (!stop && composerContainsOnlyNudge() && (state.pro ||
        (lastBlockedTurnKey && state.turnKey === lastBlockedTurnKey))) {
      block(event, state, "send-nudge");
    }
  }, true);

  globalThis.CGAntiCurseProRecoveryGuard = {
    modelSlugIsPro,
    activeProRun,
    debug() {
      const state = activeProRun();
      return {
        activeProRun: state.pro,
        activeModelSlug: state.modelSlug,
        activeTurnKey: state.turnKey,
        blockedClicks,
        lastBlockedTurnKey,
        lastBlockedModelSlug
      };
    }
  };
})();
