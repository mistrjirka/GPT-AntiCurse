/*
 * Lightweight reader for older visible conversation turns.
 *
 * This file deliberately owns all DOM that it creates. Nothing is inserted into
 * ChatGPT's React-managed conversation subtree; the reader is a top-level Shadow
 * DOM overlay. The controller in windowed.js decides when to open it.
 */
(function (global) {
  "use strict";

  const DEFAULT_PAGE_SIZE = 64;
  const MAX_RENDERED_TURNS = 500;

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function makeTurn(message, index) {
    const turn = document.createElement("article");
    turn.className = `turn ${message.role === "user" ? "user" : "assistant"}`;
    turn.dataset.index = String(index);

    const heading = document.createElement("div");
    heading.className = "head";
    heading.textContent = message.role === "user" ? "You" : "Assistant";

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.text || "[Non-text visible message]";

    turn.append(heading, body);
    return turn;
  }

  class HistoryOverlay {
    constructor(options = {}) {
      this.onClose = typeof options.onClose === "function" ? options.onClose : () => {};
      this.history = null;
      this.host = null;
      this.overlay = null;
      this.viewport = null;
      this.list = null;
      this.marker = null;
      this.previousButton = null;
      this.opened = false;
      this.loadedStart = 0;
      this.loadedEnd = 0;
      this.olderCount = 0;
      this.scrollFramePending = false;
    }

    setHistory(history) {
      this.history = history && Array.isArray(history.messages) ? history : null;
      if (!this.history) this.close();
    }

    hasOlderTurns() {
      return this._olderTurnCount() > 0;
    }

    isOpen() {
      return this.opened;
    }

    open() {
      if (this.opened || !this.hasOlderTurns()) return false;
      this._ensureDom();
      this._renderInitialPage();
      this.opened = true;
      this.overlay.classList.add("open");

      requestAnimationFrame(() => {
        this.viewport.scrollTop = this.viewport.scrollHeight;
        try {
          this.viewport.focus({ preventScroll: true });
        } catch (_) {
          this.viewport.focus();
        }
      });
      return true;
    }

    close() {
      if (!this.opened) return;
      this.opened = false;
      if (this.overlay) this.overlay.classList.remove("open");
      this.onClose();
    }

    destroy() {
      this.close();
      if (this.host) this.host.remove();
      this.host = null;
      this.overlay = null;
      this.viewport = null;
      this.list = null;
      this.marker = null;
      this.previousButton = null;
    }

    loadOlderPage() {
      if (!this.history || !this.list || this.loadedStart <= 0) return false;

      const nextStart = Math.max(0, this.loadedStart - this._pageSize());
      const anchor = this.list.firstElementChild;
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      const fragment = document.createDocumentFragment();

      for (let index = nextStart; index < this.loadedStart; index++) {
        fragment.appendChild(makeTurn(this.history.messages[index], index));
      }

      this.list.insertBefore(fragment, this.list.firstChild);
      this.loadedStart = nextStart;
      this._trimFromNewestEnd();
      this._updateHeader();
      this._preserveAnchor(anchor, anchorTop);
      return true;
    }

    loadNewerPage() {
      if (!this.history || !this.list || this.loadedEnd >= this.olderCount) return false;

      const nextEnd = Math.min(this.olderCount, this.loadedEnd + this._pageSize());
      const anchor = this.list.lastElementChild;
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      const fragment = document.createDocumentFragment();

      for (let index = this.loadedEnd; index < nextEnd; index++) {
        fragment.appendChild(makeTurn(this.history.messages[index], index));
      }

      this.list.appendChild(fragment);
      this.loadedEnd = nextEnd;
      this._trimFromOldestEnd();
      this._updateHeader();
      this._preserveAnchor(anchor, anchorTop);
      return true;
    }

    _olderTurnCount() {
      if (!this.history) return 0;
      const nativeCount = Math.max(0, Number(this.history.nativeVisibleCount) || 0);
      return Math.max(0, this.history.messages.length - nativeCount);
    }

    _pageSize() {
      return clamp(this.history && this.history.pageSize, 4, 500, DEFAULT_PAGE_SIZE);
    }

    _maxRendered() {
      const fallback = Math.min(MAX_RENDERED_TURNS, this._pageSize() * 3);
      return clamp(this.history && this.history.maxRendered, this._pageSize(), MAX_RENDERED_TURNS, fallback);
    }

    _renderInitialPage() {
      this.olderCount = this._olderTurnCount();
      this.loadedEnd = this.olderCount;
      this.loadedStart = Math.max(0, this.loadedEnd - this._pageSize());
      this.list.replaceChildren();

      const fragment = document.createDocumentFragment();
      for (let index = this.loadedStart; index < this.loadedEnd; index++) {
        fragment.appendChild(makeTurn(this.history.messages[index], index));
      }
      this.list.appendChild(fragment);
      this._updateHeader();
    }

    _trimFromNewestEnd() {
      while (this.list.children.length > this._maxRendered()) {
        this.list.lastElementChild.remove();
        this.loadedEnd--;
      }
    }

    _trimFromOldestEnd() {
      while (this.list.children.length > this._maxRendered()) {
        this.list.firstElementChild.remove();
        this.loadedStart++;
      }
    }

    _preserveAnchor(anchor, previousTop) {
      if (!anchor || !this.viewport) return;
      const delta = anchor.getBoundingClientRect().top - previousTop;
      if (Math.abs(delta) > 0.5) this.viewport.scrollTop += delta;
    }

    _updateHeader() {
      if (!this.marker || !this.previousButton) return;
      const shown = Math.max(0, this.loadedEnd - this.loadedStart);
      const firstShown = this.loadedStart + 1;

      this.marker.textContent = `${shown.toLocaleString()} shown · ${firstShown.toLocaleString()}–${this.loadedEnd.toLocaleString()} of ${this.olderCount.toLocaleString()} older turns`;

      const previousCount = Math.min(this._pageSize(), this.loadedStart);
      this.previousButton.textContent = previousCount ? `Load previous ${previousCount}` : "Start reached";
      this.previousButton.disabled = previousCount === 0;
    }

    _onScroll() {
      if (!this.opened || this.scrollFramePending) return;
      this.scrollFramePending = true;
      requestAnimationFrame(() => {
        this.scrollFramePending = false;
        if (!this.opened) return;

        if (this.viewport.scrollTop < 260) this.loadOlderPage();
        const bottomGap = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
        if (bottomGap < 260 && this.loadedEnd < this.olderCount) this.loadNewerPage();
      });
    }

    _onWheel(event) {
      if (!this.opened) return;
      const bottomGap = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
      if (event.deltaY > 0 && this.loadedEnd >= this.olderCount && bottomGap < 3) {
        event.preventDefault();
        this.close();
      }
    }

    _ensureDom() {
      if (this.host && this.host.isConnected) return;

      this.host = document.createElement("div");
      this.host.id = "cg-window-history-host";
      this.host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
      document.documentElement.appendChild(this.host);

      const shadow = this.host.attachShadow({ mode: "closed" });
      shadow.innerHTML = this._template();
      this.overlay = shadow.querySelector(".overlay");
      this.viewport = shadow.querySelector(".viewport");
      this.list = shadow.querySelector(".list");
      this.marker = shadow.querySelector(".marker");
      this.previousButton = shadow.querySelector(".previous");

      this.previousButton.addEventListener("click", () => this.loadOlderPage());
      shadow.querySelector(".back").addEventListener("click", () => this.close());
      this.viewport.addEventListener("scroll", () => this._onScroll(), { passive: true });
      this.viewport.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
      this.viewport.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.close();
      });
    }

    _template() {
      return `
        <style>
          :host { all: initial; }
          .overlay { position: fixed; inset: 0; display: none; pointer-events: auto; background: #111113; color: #ececec; font: 14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
          .overlay.open { display: flex; flex-direction: column; }
          .topbar { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid rgba(255,255,255,.09); background: #171719; }
          .brand { font-weight: 700; color: #67e8d3; }
          .marker { flex: 1; min-width: 0; color: #92969e; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          button { border: 1px solid rgba(255,255,255,.13); border-radius: 8px; background: #242427; color: #f3f4f6; padding: 6px 9px; font: 600 12px system-ui; cursor: pointer; }
          button:hover { background: #303034; }
          button:disabled { opacity: .4; cursor: default; }
          .viewport { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
          .list { width: min(52rem, calc(100% - 32px)); margin: auto; padding: 18px 0 54px; display: grid; gap: 16px; }
          .turn { padding: 10px 14px; border-radius: 13px; overflow-wrap: anywhere; }
          .turn.user { margin-left: min(14%,5rem); background: #2b2b2e; }
          .turn.assistant { margin-right: min(8%,3rem); }
          .head { color: #6ee7d2; font-size: 11px; font-weight: 700; margin-bottom: 5px; }
          .body { white-space: pre-wrap; }
          .hint { width: max-content; max-width: calc(100% - 32px); margin: 12px auto 0; color: #777f88; font-size: 11px; text-align: center; }
        </style>
        <section class="overlay" role="dialog" aria-label="Older visible ChatGPT history">
          <div class="topbar">
            <span class="brand">AntiCurse history</span>
            <span class="marker"></span>
            <button class="previous" type="button"></button>
            <button class="back" type="button">Back to recent</button>
          </div>
          <div class="viewport" tabindex="0">
            <div class="hint">Visible user/assistant turns only. Scroll to page through older history.</div>
            <div class="list"></div>
          </div>
        </section>`;
    }
  }

  global.CGHistoryOverlay = {
    create(options) {
      return new HistoryOverlay(options);
    }
  };
})(globalThis);
