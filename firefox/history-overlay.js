/*
 * Inline reader for older visible conversation turns.
 *
 * Archived turns are rendered as lightweight extension-owned DOM immediately
 * before ChatGPT's native #thread, so they participate in the same scroll flow.
 * ChatGPT's React-owned message nodes are never modified or replaced.
 */
(function (global) {
  "use strict";

  const DEFAULT_PAGE_SIZE = 64;

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function makeTurn(message, index) {
    const turn = document.createElement("article");
    turn.className = `turn ${message.role === "user" ? "user" : "assistant"}`;
    turn.dataset.index = String(index);

    const inner = document.createElement("div");
    inner.className = "inner";

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.text || "[Non-text visible message]";

    inner.appendChild(body);
    turn.appendChild(inner);
    return turn;
  }

  class InlineHistory {
    constructor(options = {}) {
      this.getScroller = typeof options.getScroller === "function" ? options.getScroller : () => null;
      this.history = null;
      this.mode = "recent";
      this.host = null;
      this.shadow = null;
      this.list = null;
      this.control = null;
      this.previousButton = null;
      this.marker = null;
      this.loadedStart = 0;
      this.olderCount = 0;
    }

    setHistory(history) {
      this.history = history && Array.isArray(history.messages) ? history : null;
      this.olderCount = this._olderTurnCount();
      this.loadedStart = this.olderCount;
      this._ensureDom();
      if (this.list) this.list.replaceChildren();
      this._updateControl();
    }

    setMode(mode) {
      this.mode = mode || "recent";
      this._updateControl();
    }

    ensureAttached() {
      return this._ensureDom();
    }

    hasOlderTurns() {
      return this.olderCount > 0;
    }

    hasMoreOlderTurns() {
      return this.loadedStart > 0;
    }

    loadedCount() {
      return Math.max(0, this.olderCount - this.loadedStart);
    }

    loadPreviousPage(options = {}) {
      if (!this.history || !this.hasMoreOlderTurns()) {
        return { ok: false, reason: "start-reached", count: 0 };
      }
      if (!this._ensureDom() || !this.list) {
        return { ok: false, reason: "thread-not-found", count: 0 };
      }

      const scroller = this.getScroller();
      const preserveScroll = options.preserveScroll !== false;
      const beforeTop = scroller ? Math.max(0, Number(scroller.scrollTop) || 0) : 0;
      const beforeHeight = scroller ? Math.max(0, Number(scroller.scrollHeight) || 0) : 0;
      const end = this.loadedStart;
      const start = Math.max(0, end - this._pageSize());
      const fragment = document.createDocumentFragment();

      for (let index = start; index < end; index++) {
        fragment.appendChild(makeTurn(this.history.messages[index], index));
      }
      this.list.insertBefore(fragment, this.list.firstChild);
      this.loadedStart = start;
      this._updateControl();

      if (scroller && preserveScroll) {
        requestAnimationFrame(() => {
          if (!scroller.isConnected) return;
          const added = Math.max(0, (Number(scroller.scrollHeight) || 0) - beforeHeight);
          scroller.scrollTop = beforeTop + added;
        });
      }

      return {
        ok: true,
        count: end - start,
        loaded: this.loadedCount(),
        remaining: this.loadedStart
      };
    }

    destroy() {
      if (this.host) this.host.remove();
      this.host = null;
      this.shadow = null;
      this.list = null;
      this.control = null;
      this.previousButton = null;
      this.marker = null;
      this.history = null;
      this.loadedStart = 0;
      this.olderCount = 0;
    }

    _olderTurnCount() {
      if (!this.history) return 0;
      const nativeCount = Math.max(0, Number(this.history.nativeVisibleCount) || 0);
      return Math.max(0, this.history.messages.length - nativeCount);
    }

    _pageSize() {
      return clamp(this.history && this.history.pageSize, 4, 500, DEFAULT_PAGE_SIZE);
    }

    _findThread() {
      return document.querySelector("#thread") ||
        document.querySelector('[data-testid^="conversation-turn-"]')?.closest("#thread");
    }

    _ensureDom() {
      const thread = this._findThread();
      if (!thread || !thread.parentElement) return false;

      if (!this.host) {
        this.host = document.createElement("div");
        this.host.id = "cg-window-history-host";
        this.host.style.cssText = "display:block;width:100%;min-width:0;flex:none;";
        this.shadow = this.host.attachShadow({ mode: "closed" });
        this.shadow.innerHTML = this._template();
        this.list = this.shadow.querySelector(".list");
        this.control = this.shadow.querySelector(".control");
        this.previousButton = this.shadow.querySelector(".previous");
        this.marker = this.shadow.querySelector(".marker");
        this.previousButton.addEventListener("click", () => this.loadPreviousPage({ preserveScroll: true }));
      }

      if (this.host.parentElement !== thread.parentElement || this.host.nextSibling !== thread) {
        thread.parentElement.insertBefore(this.host, thread);
      }
      this._updateControl();
      return true;
    }

    _updateControl() {
      if (!this.control || !this.previousButton || !this.marker) return;

      const remaining = this.loadedStart;
      const nextCount = Math.min(this._pageSize(), remaining);
      const fixedMode = this.mode === "recent" || this.mode === "latest-visible";
      const shouldShow = fixedMode && this.hasOlderTurns();
      this.control.hidden = !shouldShow;

      if (!shouldShow) return;
      if (remaining > 0) {
        this.previousButton.disabled = false;
        this.previousButton.textContent = `Load previous ${nextCount}`;
      } else {
        this.previousButton.disabled = true;
        this.previousButton.textContent = "Start reached";
      }

      const loaded = this.loadedCount();
      this.marker.textContent = loaded
        ? `${loaded.toLocaleString()} older turns loaded`
        : `${this.olderCount.toLocaleString()} older turns available`;
    }

    _template() {
      return `
        <style>
          :host {
            all: initial;
            display: block;
            width: 100%;
            color: var(--text-primary, CanvasText);
            color-scheme: light dark;
            font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          }
          .history { width: 100%; }
          .control {
            width: min(48rem, calc(100% - 32px));
            margin: 8px auto 10px;
            padding: 0 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
          }
          .control[hidden] { display: none; }
          .marker { color: var(--text-tertiary, #8e8e93); font-size: 11px; }
          button {
            min-height: 32px;
            border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
            border-radius: 999px;
            padding: 6px 11px;
            background: var(--main-surface-secondary, color-mix(in srgb, CanvasText 7%, Canvas));
            color: var(--text-primary, CanvasText);
            font: 600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            cursor: pointer;
          }
          button:hover:not(:disabled) { background: color-mix(in srgb, CanvasText 11%, Canvas); }
          button:focus-visible { outline: 2px solid #10a37f; outline-offset: 2px; }
          button:disabled { opacity: .5; cursor: default; }
          .list { display: flex; width: 100%; flex-direction: column; }
          .turn {
            width: 100%;
            padding: 10px 0 14px;
            content-visibility: auto;
            contain-intrinsic-size: auto 120px;
          }
          .inner {
            width: min(48rem, calc(100% - 32px));
            margin: 0 auto;
            padding: 0 16px;
            box-sizing: border-box;
          }
          .body {
            color: var(--text-primary, CanvasText);
            font-size: 16px;
            line-height: 1.55;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          .user .inner { display: flex; justify-content: flex-end; }
          .user .body {
            width: fit-content;
            max-width: 70%;
            padding: 10px 16px;
            border-radius: 22px;
            background: var(--main-surface-secondary, color-mix(in srgb, CanvasText 8%, Canvas));
          }
          .assistant .body { width: 100%; }
        </style>
        <section class="history" aria-label="Older ChatGPT history loaded by GPT AntiCurse">
          <div class="control">
            <button class="previous" type="button"></button>
            <span class="marker"></span>
          </div>
          <div class="list"></div>
        </section>`;
    }
  }

  global.CGHistoryOverlay = {
    create(options) {
      return new InlineHistory(options);
    }
  };
})(globalThis);
