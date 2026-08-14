/* Native-looking light-DOM renderer for archived turns. Loaded after history-overlay.js. */
(function (global) {
  "use strict";

  const DEFAULT_PAGE_SIZE = 64;
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  function appendInline(parent, source) {
    const text = String(source || "");
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > at) parent.append(document.createTextNode(text.slice(at, m.index)));
      const token = m[0];
      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else {
        const split = token.lastIndexOf("](");
        const label = token.slice(1, split);
        const rawHref = token.slice(split + 2, -1);
        try {
          const url = new URL(rawHref, location.href);
          if (/^https?:$/.test(url.protocol)) {
            const a = document.createElement("a");
            a.href = url.href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = label;
            parent.append(a);
          } else parent.append(document.createTextNode(token));
        } catch (_) { parent.append(document.createTextNode(token)); }
      }
      at = m.index + token.length;
    }
    if (at < text.length) parent.append(document.createTextNode(text.slice(at)));
  }

  function cells(line) {
    let s = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split("|").map((part) => part.trim());
  }
  function divider(line) {
    const c = cells(line);
    return c.length > 1 && c.every((part) => /^:?-{3,}:?$/.test(part));
  }

  function renderMarkdown(root, source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      let m = lines[i].match(/^\s*```([^`]*)$/);
      if (m) {
        const language = m[1].trim();
        const body = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
        if (i < lines.length) i++;
        const pre = document.createElement("pre");
        pre.className = "cg-history-code";
        const code = document.createElement("code");
        if (language) code.dataset.language = language;
        code.textContent = body.join("\n");
        pre.append(code);
        root.append(pre);
        continue;
      }
      m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (m) {
        const h = document.createElement(`h${m[1].length}`);
        appendInline(h, m[2]);
        root.append(h);
        i++;
        continue;
      }
      if (i + 1 < lines.length && lines[i].includes("|") && divider(lines[i + 1])) {
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const hr = document.createElement("tr");
        for (const value of cells(lines[i])) { const th = document.createElement("th"); appendInline(th, value); hr.append(th); }
        head.append(hr); table.append(head); i += 2;
        const body = document.createElement("tbody");
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const tr = document.createElement("tr");
          for (const value of cells(lines[i++])) { const td = document.createElement("td"); appendInline(td, value); tr.append(td); }
          body.append(tr);
        }
        table.append(body); root.append(table); continue;
      }
      if (/^\s*>\s?/.test(lines[i])) {
        const q = document.createElement("blockquote");
        const qLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) qLines.push(lines[i++].replace(/^\s*>\s?/, ""));
        renderMarkdown(q, qLines.join("\n")); root.append(q); continue;
      }
      m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
      if (m) {
        const ordered = /^\d/.test(m[1]);
        const list = document.createElement(ordered ? "ol" : "ul");
        while (i < lines.length) {
          const item = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const li = document.createElement("li"); appendInline(li, item[2]); list.append(li); i++;
        }
        root.append(list); continue;
      }
      const paragraph = [];
      while (i < lines.length && lines[i].trim()) {
        if (paragraph.length && (/^\s*```/.test(lines[i]) || /^\s{0,3}#{1,6}\s+/.test(lines[i]) || /^\s*>\s?/.test(lines[i]) || /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))) break;
        if (i + 1 < lines.length && lines[i].includes("|") && divider(lines[i + 1])) break;
        paragraph.push(lines[i++]);
      }
      if (paragraph.length) {
        const p = document.createElement("p");
        paragraph.forEach((line, index) => { if (index) p.append(document.createElement("br")); appendInline(p, line); });
        root.append(p);
      } else i++;
    }
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

  function turn(message) {
    const section = document.createElement("section");
    section.className = "cg-history-turn text-token-text-primary w-full";
    section.dataset.cgRole = message.role;
    section.__cgSourceText = message.text;
    const outer = document.createElement("div");
    outer.className = `cg-history-turn-outer text-base my-auto mx-auto ${message.role === "user" ? "cg-history-user-spacing" : "cg-history-assistant-spacing"}`;
    const width = document.createElement("div");
    width.className = "cg-history-turn-width group/turn-messages relative flex w-full min-w-0 flex-col";
    const msg = document.createElement("div");
    msg.className = `cg-history-message min-h-8 text-message relative flex w-full flex-col gap-2 text-start break-words whitespace-normal ${message.role === "user" ? "items-end" : "items-start"}`;
    const md = document.createElement("div");
    md.className = "cg-history-markdown markdown prose dark:prose-invert wrap-break-word dark markdown-new-styling";
    renderMarkdown(md, message.text);
    if (message.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "cg-history-user-bubble corner-superellipse/0.98 relative min-w-0 overflow-hidden rounded-[22px] px-4 py-2.5 leading-6 user-message-bubble-color";
      bubble.append(md); msg.append(bubble);
    } else { md.classList.add("w-full"); msg.append(md); }
    width.append(msg); outer.append(width); section.append(outer); return section;
  }

  class NativeHistory {
    constructor(options = {}) {
      this.getScroller = typeof options.getScroller === "function" ? options.getScroller : () => null;
      this.history = null; this.mode = "recent"; this.host = null; this.list = null;
      this.control = null; this.button = null; this.marker = null; this.loadedStart = 0; this.olderCount = 0;
    }
    setHistory(value) {
      this.history = value && Array.isArray(value.messages) ? value : null;
      const nativeCount = this.history ? Math.max(0, Number(this.history.nativeVisibleCount) || 0) : 0;
      this.olderCount = this.history ? Math.max(0, this.history.messages.length - nativeCount) : 0;
      this.loadedStart = this.olderCount; this.ensureAttached(); if (this.list) this.list.replaceChildren(); this.update();
    }
    setMode(value) { this.mode = value === "windowed-visible" ? "windowed-visible" : "recent"; this.update(); }
    hasOlderTurns() { return this.olderCount > 0; }
    hasMoreOlderTurns() { return this.loadedStart > 0; }
    pageSize() { return clamp(this.history && this.history.pageSize, 4, 500, DEFAULT_PAGE_SIZE); }
    loadedCount() { return Math.max(0, this.olderCount - this.loadedStart); }
    loadPreviousPage(options = {}) {
      if (!this.history || !this.hasMoreOlderTurns()) return { ok: false, reason: "start-reached", count: 0 };
      if (!this.ensureAttached()) return { ok: false, reason: "thread-not-found", count: 0 };
      const scroller = this.getScroller();
      const beforeTop = scroller ? Number(scroller.scrollTop) || 0 : 0;
      const beforeHeight = scroller ? Number(scroller.scrollHeight) || 0 : 0;
      const end = this.loadedStart, start = Math.max(0, end - this.pageSize());
      const groups = grouped(this.history.messages, start, end);
      const first = this.list.firstElementChild, last = groups[groups.length - 1];
      if (first && last && last.role === "assistant" && first.dataset.cgRole === "assistant") { last.text += `\n\n${first.__cgSourceText || ""}`; first.remove(); }
      const fragment = document.createDocumentFragment();
      groups.forEach((item) => fragment.append(turn(item)));
      this.list.insertBefore(fragment, this.list.firstChild); this.loadedStart = start; this.update();
      if (scroller && options.preserveScroll !== false) requestAnimationFrame(() => { if (scroller.isConnected) scroller.scrollTop = beforeTop + Math.max(0, (Number(scroller.scrollHeight) || 0) - beforeHeight); });
      return { ok: true, count: end - start, loaded: this.loadedCount(), remaining: this.loadedStart };
    }
    ensureAttached() {
      const thread = document.querySelector("#thread"); if (!thread || !thread.parentElement) return false;
      if (!this.host) {
        this.host = document.createElement("div"); this.host.id = "cg-window-history-host"; this.host.className = "cg-window-history-host";
        this.host.innerHTML = '<div class="cg-history-control" hidden><button class="cg-history-previous" type="button"></button><span class="cg-history-marker text-token-text-tertiary"></span></div><div class="cg-history-list"></div>';
        this.list = this.host.querySelector(".cg-history-list"); this.control = this.host.querySelector(".cg-history-control");
        this.button = this.host.querySelector(".cg-history-previous"); this.marker = this.host.querySelector(".cg-history-marker");
        this.button.addEventListener("click", () => this.loadPreviousPage({ preserveScroll: true }));
      }
      if (this.host.parentElement !== thread.parentElement || this.host.nextSibling !== thread) thread.parentElement.insertBefore(this.host, thread);
      this.update(); return true;
    }
    update() {
      if (!this.control) return;
      const show = this.mode === "recent" && this.hasOlderTurns(); this.control.hidden = !show; if (!show) return;
      const next = Math.min(this.pageSize(), this.loadedStart);
      this.button.disabled = this.loadedStart <= 0; this.button.textContent = this.loadedStart > 0 ? `Load previous ${next}` : "Start reached";
      this.marker.textContent = this.loadedCount() ? `${this.loadedCount().toLocaleString()} older turns loaded` : `${this.olderCount.toLocaleString()} older turns available`;
    }
    destroy() { if (this.host) this.host.remove(); this.host = this.list = this.control = this.button = this.marker = this.history = null; this.loadedStart = this.olderCount = 0; }
  }

  global.CGHistoryOverlay = { create(options) { return new NativeHistory(options); }, renderMarkdown };
})(globalThis);
