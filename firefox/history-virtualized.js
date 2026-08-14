/*
 * Bounded DOM window for AntiCurse-owned archived history.
 * Loaded history remains logically available, but only a small contiguous set
 * of measured pages stays mounted. Off-screen pages become equal-height spacers
 * and are reconstructed when the viewport approaches them.
 */
(function (global) {
  "use strict";

  const prior = global.CGHistoryOverlay;
  const renderMarkdown = prior && prior.renderMarkdown;
  if (typeof renderMarkdown !== "function") return;

  const DEFAULT_PAGE_SIZE = 64;

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function logicalUnitCount(messages, start = 0, end = messages.length) {
    let count = 0;
    let previousRole = null;
    for (let index = Math.max(0, start); index < Math.min(messages.length, end); index++) {
      const role = messages[index] && messages[index].role === "user" ? "user" : "assistant";
      if (role === "user" || previousRole !== "assistant") count++;
      previousRole = role;
    }
    return count;
  }

  function previousLogicalStart(messages, end, limit) {
    let index = Math.min(messages.length, end) - 1;
    let start = end;
    let units = 0;

    while (index >= 0 && units < limit) {
      const role = messages[index] && messages[index].role === "user" ? "user" : "assistant";
      if (role === "assistant") {
        let runStart = index;
        while (runStart > 0 && messages[runStart - 1] && messages[runStart - 1].role !== "user") runStart--;
        start = runStart;
        index = runStart - 1;
      } else {
        start = index;
        index--;
      }
      units++;
    }
    return Math.max(0, start);
  }

  function grouped(messages, start, end) {
    const result = [];
    for (let index = start; index < end; index++) {
      const raw = messages[index] || {};
      const role = raw.role === "user" ? "user" : "assistant";
      const text = raw.text || "[Non-text visible message]";
      const previous = result[result.length - 1];
      if (role === "assistant" && previous && previous.role === "assistant") previous.text += `\n\n${text}`;
      else result.push({ role, text, index });
    }
    return result;
  }

  function estimatePageHeight(groups) {
    let height = 0;
    for (const message of groups) {
      const text = String(message && message.text || "");
      const explicitLines = Math.max(1, text.split("\n").length);
      const wrapWidth = message && message.role === "user" ? 68 : 88;
      const wrappedLines = Math.max(1, Math.ceil(text.length / wrapWidth));
      const contentLines = Math.max(explicitLines, wrappedLines);
      const verticalChrome = message && message.role === "user" ? 78 : 64;
      height += verticalChrome + contentLines * 24;
    }
    return Math.max(140, height);
  }

  function createTurn(message) {
    const section = document.createElement("section");
    section.className = "cg-history-turn text-token-text-primary w-full";
    section.dataset.cgRole = message.role;

    const outer = document.createElement("div");
    outer.className = `cg-history-turn-outer text-base my-auto mx-auto ${message.role === "user" ? "cg-history-user-spacing" : "cg-history-assistant-spacing"}`;

    const width = document.createElement("div");
    width.className = "cg-history-turn-width group/turn-messages relative flex w-full min-w-0 flex-col";

    const container = document.createElement("div");
    container.className = `cg-history-message min-h-8 text-message relative flex w-full flex-col gap-2 text-start break-words whitespace-normal ${message.role === "user" ? "items-end" : "items-start"}`;

    const markdown = document.createElement("div");
    markdown.className = "cg-history-markdown markdown prose dark:prose-invert wrap-break-word dark markdown-new-styling";
    renderMarkdown(markdown, message.text);

    if (message.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "cg-history-user-bubble corner-superellipse/0.98 relative min-w-0 overflow-hidden rounded-[22px] px-4 py-2.5 leading-6 user-message-bubble-color";
      bubble.append(markdown);
      container.append(bubble);
    } else {
      markdown.classList.add("w-full");
      container.append(markdown);
    }

    width.append(container);
    outer.append(width);
    section.append(outer);
    return section;
  }

  function scrollerTarget(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller;
  }

  function viewportBounds(scroller) {
    if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement) {
      return { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight || 800 };
    }
    const rect = scroller.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }

  class VirtualHistory {
    constructor(options = {}) {
      this.getScroller = typeof options.getScroller === "function" ? options.getScroller : () => null;
      this.history = null;
      this.mode = "recent";
      this.host = null;
      this.list = null;
      this.control = null;
      this.button = null;
      this.marker = null;
      this.topSpacer = null;
      this.bottomSpacer = null;
      this.pages = [];
      this.renderStart = 0;
      this.loadedStart = 0;
      this.olderCount = 0;
      this.boundScroller = null;
      this.boundTarget = null;
      this.virtualRaf = 0;
      this.onScroll = () => this.scheduleVirtualize();
    }

    setHistory(value) {
      this.history = value && Array.isArray(value.messages) ? value : null;
      const nativeCount = this.history ? Math.max(0, Number(this.history.nativeVisibleCount) || 0) : 0;
      this.olderCount = this.history ? Math.max(0, this.history.messages.length - nativeCount) : 0;
      this.loadedStart = this.olderCount;
      this.pages = [];
      this.renderStart = 0;
      this.ensureAttached();
      if (this.list && this.topSpacer && this.bottomSpacer) this.list.replaceChildren(this.topSpacer, this.bottomSpacer);
      this.updateSpacers();
      this.update();
    }

    setMode(value) {
      this.mode = value === "windowed-visible" ? "windowed-visible" : "recent";
      this.update();
    }

    hasOlderTurns() { return this.olderCount > 0; }
    hasMoreOlderTurns() { return this.loadedStart > 0; }

    pageSize() {
      return clamp(this.history && this.history.pageSize, 4, 500, DEFAULT_PAGE_SIZE);
    }

    maxPages() {
      const page = this.pageSize();
      const maxRendered = clamp(this.history && this.history.maxRendered, page, 4000, page * 3);
      return clamp(Math.ceil(maxRendered / page), 2, 8, 3);
    }

    loadedCount() {
      return this.pages.reduce((sum, page) => sum + page.units, 0);
    }

    remainingCount() {
      if (!this.history || this.loadedStart <= 0) return 0;
      return logicalUnitCount(this.history.messages, 0, this.loadedStart);
    }

    loadPreviousPage(options = {}) {
      if (!this.history || !this.hasMoreOlderTurns()) return { ok: false, reason: "start-reached", count: 0 };
      if (!this.ensureAttached()) return { ok: false, reason: "thread-not-found", count: 0 };

      const scroller = this.getScroller();
      const beforeTop = scroller ? Math.max(0, Number(scroller.scrollTop) || 0) : 0;
      const beforeHeight = scroller ? Math.max(0, Number(scroller.scrollHeight) || 0) : 0;
      const end = this.loadedStart;
      const start = previousLogicalStart(this.history.messages, end, this.pageSize());
      if (start >= end) return { ok: false, reason: "start-reached", count: 0 };

      const units = logicalUnitCount(this.history.messages, start, end);
      const page = {
        start,
        end,
        units,
        height: 0,
        estimatedHeight: Math.max(140, units * 116),
        element: null
      };
      this.pages.unshift(page);
      this.loadedStart = start;
      this.renderWindow(0);
      this.update();

      if (scroller && options.preserveScroll !== false) {
        requestAnimationFrame(() => {
          if (!scroller.isConnected) return;
          const added = Math.max(0, (Number(scroller.scrollHeight) || 0) - beforeHeight);
          scroller.scrollTop = beforeTop + added;
        });
      }

      return {
        ok: true,
        count: page.units,
        rawCount: end - start,
        loaded: this.loadedCount(),
        remaining: this.remainingCount(),
        renderedPages: Math.min(this.pages.length, this.maxPages())
      };
    }

    createPage(page) {
      if (page.element) return page.element;
      const element = document.createElement("div");
      element.className = "cg-history-page";
      element.dataset.cgStart = String(page.start);
      element.dataset.cgEnd = String(page.end);
      const groups = grouped(this.history.messages, page.start, page.end);
      page.estimatedHeight = estimatePageHeight(groups);
      const fragment = document.createDocumentFragment();
      for (const message of groups) fragment.append(createTurn(message));
      element.append(fragment);
      page.element = element;
      return element;
    }

    measurePage(page) {
      const element = page && page.element;
      if (!element || !element.isConnected) return 0;

      let observed = Math.max(
        Number(element.getBoundingClientRect().height) || 0,
        Number(element.offsetHeight) || 0,
        Number(element.scrollHeight) || 0
      );

      // content-visibility:auto is intentionally used for archived turns. Some
      // browser/layout states report a zero wrapper height for an offscreen page.
      // Force layout only for the <= maxPages mounted archive pages, then restore
      // the normal lightweight behavior. This never touches ChatGPT-owned nodes.
      if (!(observed > 0)) {
        const turns = Array.from(element.querySelectorAll(".cg-history-turn"));
        const previous = turns.map((turn) => turn.style.contentVisibility);
        turns.forEach((turn) => { turn.style.contentVisibility = "visible"; });
        observed = Math.max(
          Number(element.getBoundingClientRect().height) || 0,
          Number(element.offsetHeight) || 0,
          Number(element.scrollHeight) || 0
        );
        turns.forEach((turn, index) => {
          if (previous[index]) turn.style.contentVisibility = previous[index];
          else turn.style.removeProperty("content-visibility");
        });
      }

      if (Number.isFinite(observed) && observed > 0) {
        page.height = observed;
        page.estimatedHeight = observed;
        return observed;
      }
      return 0;
    }

    pageSpace(page) {
      if (!page) return 0;
      if (Number(page.height) > 0) return page.height;
      const measured = this.measurePage(page);
      if (measured > 0) return measured;
      return Math.max(140, Number(page.estimatedHeight) || Number(page.units) * 116 || 140);
    }

    measureMountedPages() {
      for (const page of this.pages) {
        if (page.element && page.element.isConnected) this.measurePage(page);
      }
    }

    updateSpacers() {
      if (!this.topSpacer || !this.bottomSpacer) return;
      const end = Math.min(this.pages.length, this.renderStart + this.maxPages());
      const topHeight = this.pages.slice(0, this.renderStart).reduce((sum, page) => sum + this.pageSpace(page), 0);
      const bottomHeight = this.pages.slice(end).reduce((sum, page) => sum + this.pageSpace(page), 0);
      this.topSpacer.style.height = `${topHeight}px`;
      this.bottomSpacer.style.height = `${bottomHeight}px`;
      this.topSpacer.hidden = topHeight <= 0;
      this.bottomSpacer.hidden = bottomHeight <= 0;
    }

    renderWindow(requestedStart) {
      if (!this.list || !this.topSpacer || !this.bottomSpacer) return;
      this.measureMountedPages();

      const maxStart = Math.max(0, this.pages.length - this.maxPages());
      this.renderStart = clamp(requestedStart, 0, maxStart, 0);
      const end = Math.min(this.pages.length, this.renderStart + this.maxPages());
      const children = [this.topSpacer];
      for (let index = this.renderStart; index < end; index++) children.push(this.createPage(this.pages[index]));
      children.push(this.bottomSpacer);
      this.list.replaceChildren(...children);
      this.updateSpacers();

      requestAnimationFrame(() => {
        this.measureMountedPages();
        this.updateSpacers();
        this.scheduleVirtualize();
      });
    }

    scheduleVirtualize() {
      if (this.virtualRaf || this.pages.length <= this.maxPages()) return;
      this.virtualRaf = requestAnimationFrame(() => {
        this.virtualRaf = 0;
        this.virtualize();
      });
    }

    virtualize() {
      if (!this.pages.length || this.pages.length <= this.maxPages()) return;
      const scroller = this.getScroller();
      if (!scroller) return;
      const end = Math.min(this.pages.length, this.renderStart + this.maxPages());
      const first = this.pages[this.renderStart] && this.pages[this.renderStart].element;
      const last = this.pages[end - 1] && this.pages[end - 1].element;
      if (!first || !last || !first.isConnected || !last.isConnected) return;

      const viewport = viewportBounds(scroller);
      const threshold = Math.max(240, (viewport.bottom - viewport.top) * 0.4);
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();

      if (this.renderStart > 0 && firstRect.top > viewport.top - threshold) {
        this.renderWindow(this.renderStart - 1);
      } else if (end < this.pages.length && lastRect.bottom < viewport.bottom + threshold) {
        this.renderWindow(this.renderStart + 1);
      }
    }

    bindScroller() {
      const scroller = this.getScroller();
      const target = scroller ? scrollerTarget(scroller) : null;
      if (this.boundScroller === scroller && this.boundTarget === target) return;
      if (this.boundTarget) this.boundTarget.removeEventListener("scroll", this.onScroll, true);
      this.boundScroller = scroller;
      this.boundTarget = target;
      if (target) target.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    }

    ensureAttached() {
      const thread = document.querySelector("#thread");
      if (!thread || !thread.parentElement) return false;

      if (!this.host) {
        this.host = document.createElement("div");
        this.host.id = "cg-window-history-host";
        this.host.className = "cg-window-history-host";
        this.host.innerHTML = '<div class="cg-history-control" hidden><button class="cg-history-previous" type="button"></button><span class="cg-history-marker text-token-text-tertiary"></span></div><div class="cg-history-list"><div class="cg-history-spacer cg-history-spacer-top" hidden></div><div class="cg-history-spacer cg-history-spacer-bottom" hidden></div></div>';
        this.list = this.host.querySelector(".cg-history-list");
        this.control = this.host.querySelector(".cg-history-control");
        this.button = this.host.querySelector(".cg-history-previous");
        this.marker = this.host.querySelector(".cg-history-marker");
        this.topSpacer = this.host.querySelector(".cg-history-spacer-top");
        this.bottomSpacer = this.host.querySelector(".cg-history-spacer-bottom");
        this.button.addEventListener("click", () => this.loadPreviousPage({ preserveScroll: true }));
      }

      if (this.host.parentElement !== thread.parentElement || this.host.nextSibling !== thread) thread.parentElement.insertBefore(this.host, thread);
      this.bindScroller();
      this.update();
      return true;
    }

    update() {
      if (!this.control || !this.button || !this.marker) return;
      const show = this.mode === "recent" && this.hasOlderTurns();
      this.control.hidden = !show;
      if (!show) return;

      const remaining = this.remainingCount();
      const next = Math.min(this.pageSize(), remaining);
      this.button.disabled = remaining <= 0;
      this.button.textContent = remaining > 0 ? `Load previous ${next}` : "Start reached";
      this.marker.textContent = this.loadedCount()
        ? `${this.loadedCount().toLocaleString()} older turns loaded · ${Math.min(this.pages.length, this.maxPages())} pages mounted`
        : `${remaining.toLocaleString()} older turns available`;
    }

    destroy() {
      if (this.virtualRaf) cancelAnimationFrame(this.virtualRaf);
      this.virtualRaf = 0;
      if (this.boundTarget) this.boundTarget.removeEventListener("scroll", this.onScroll, true);
      if (this.host) this.host.remove();
      this.history = null;
      this.host = this.list = this.control = this.button = this.marker = null;
      this.topSpacer = this.bottomSpacer = null;
      this.pages = [];
      this.renderStart = 0;
      this.loadedStart = this.olderCount = 0;
      this.boundScroller = this.boundTarget = null;
    }
  }

  global.CGHistoryOverlay = {
    create(options) { return new VirtualHistory(options); },
    renderMarkdown,
    logicalUnitCount,
    previousLogicalStart
  };
})(globalThis);
