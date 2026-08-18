/*
 * Make AntiCurse-owned archived turns visually follow the native ChatGPT thread.
 *
 * This module copies class names only. It never copies native IDs,
 * data-message-author-role, data-turn-id, React state, buttons, or event handlers.
 * The final history compositor explicitly applies this decorator to the virtual
 * renderer before the controller creates a reader.
 */
(function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const FALLBACK = Object.freeze({
    section: "text-token-text-primary w-full focus:outline-none",
    outer: "text-base my-auto mx-auto [--thread-content-margin:var(--thread-content-margin-xs,calc(var(--spacing)*4))] @w-sm/main:[--thread-content-margin:var(--thread-content-margin-sm,calc(var(--spacing)*6))] @w-lg/main:[--thread-content-margin:var(--thread-content-margin-lg,calc(var(--spacing)*16))] px-(--thread-content-margin)",
    group: "[--thread-content-max-width:40rem] @w-lg/main:[--thread-content-max-width:48rem] mx-auto max-w-(--thread-content-max-width) flex-1 group/turn-messages focus-visible:outline-hidden @[53.5rem]/main:[--thread-content-max-width:48rem] relative flex w-full min-w-0 flex-col",
    grow: "flex max-w-full flex-col gap-4 grow",
    message: "min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal outline-none keyboard-focused:focus-ring [.text-message+&]:mt-1",
    assistantBody: "flex w-full flex-col gap-1 empty:hidden",
    assistantMarkdown: "markdown prose dark:prose-invert wrap-break-word w-full dark markdown-new-styling",
    userBody: "flex w-full flex-col gap-1 empty:hidden items-end rtl:items-start",
    userBubble: "corner-superellipse/0.98 relative min-w-0 overflow-hidden rounded-[22px] px-4 py-2.5 leading-6 user-message-bubble-color max-w-(--user-chat-width,70%)",
    userText: "max-w-full min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap",
    activity: "text-token-text-tertiary flex items-start gap-2 text-start text-base leading-6"
  });

  const ACTION_LABELS = Object.freeze({
    exec_command: "Ran command",
    exec_commands: "Ran commands",
    read_file: "Read file",
    read_files: "Read files",
    search_project: "Searched files",
    search_many: "Searched files",
    list_repositories: "Inspected Development Sandbox repositories",
    list_projects: "Inspected Development Sandbox projects",
    list_sessions: "Checked Development Sandbox sessions",
    create_session: "Opened Development Sandbox session",
    get_job: "Checked Development Sandbox job",
    list_jobs: "Checked Development Sandbox jobs",
    list_processes: "Checked Development Sandbox processes",
    sandbox_health: "Checked Development Sandbox",
    apply_patch: "Edited files in Development Sandbox",
    replace_text: "Edited files in Development Sandbox",
    write_file: "Wrote file in Development Sandbox",
    git_status_diff: "Checked repository changes",
    cleanup_jobs: "Cleaned Development Sandbox jobs"
  });

  const SANDBOX_LABELS = Object.freeze({
    exec_command: "Ran command in Development Sandbox",
    exec_commands: "Ran commands in Development Sandbox",
    read_file: "Read file in Development Sandbox",
    read_files: "Read files in Development Sandbox",
    search_project: "Searched Development Sandbox",
    search_many: "Searched Development Sandbox"
  });

  const copyClass = (element, fallback) => element && typeof element.className === "string" && element.className.trim()
    ? element.className
    : fallback;

  function userTextNode(message) {
    if (!message) return null;
    const candidates = Array.from(message.querySelectorAll(".whitespace-pre-wrap"));
    return candidates.find((element) => String(element.textContent || "").trim()) || candidates[0] || null;
  }

  function userBubbleNode(message, textNode) {
    let node = textNode && textNode.parentElement;
    while (node && node !== message) {
      const classes = node.classList;
      if (classes && classes.contains("user-message-bubble-color")) return node;
      if (classes && classes.contains("leading-6") && Array.from(classes).some((name) => name.startsWith("rounded-"))) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findNativeRole(role) {
    const candidates = Array.from(document.querySelectorAll(`#thread [data-message-author-role="${role}"]`));
    if (role === "user") {
      return candidates.find((message) => {
        const text = userTextNode(message);
        return !!(text && userBubbleNode(message, text));
      }) || candidates[0] || null;
    }
    return candidates.find((message) => message.querySelector(".markdown")) || candidates[0] || null;
  }

  function templateFor(role) {
    const message = findNativeRole(role);
    if (!message) return { ...FALLBACK };

    const section = message.closest('section[data-testid^="conversation-turn-"]');
    const group = message.closest(".group\\/turn-messages");
    const outer = group && group.parentElement;
    const grow = message.parentElement;
    const body = message.firstElementChild;

    const template = {
      ...FALLBACK,
      section: copyClass(section, FALLBACK.section),
      outer: copyClass(outer, FALLBACK.outer),
      group: copyClass(group, FALLBACK.group),
      grow: copyClass(grow, FALLBACK.grow),
      message: copyClass(message, FALLBACK.message)
    };

    if (role === "user") {
      const text = userTextNode(message);
      const bubble = userBubbleNode(message, text);
      template.userBody = copyClass(body, FALLBACK.userBody);
      template.userBubble = copyClass(bubble, FALLBACK.userBubble);
      template.userText = copyClass(text, FALLBACK.userText);
    } else {
      const markdown = message.querySelector(".markdown");
      const assistantBody = markdown && markdown.parentElement !== message ? markdown.parentElement : body;
      template.assistantBody = copyClass(assistantBody, FALLBACK.assistantBody);
      template.assistantMarkdown = copyClass(markdown, FALLBACK.assistantMarkdown);
    }
    return template;
  }

  function currentActivityClass() {
    const icon = document.querySelector('#thread [data-testid="cot-v5-tool-icon-pile"], #thread [data-testid="cot-v5-native-tool-icon"]');
    let node = icon;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains("text-token-text-tertiary") && node.classList.contains("gap-2")) {
        return copyClass(node, FALLBACK.activity);
      }
      node = node.parentElement;
    }
    return FALLBACK.activity;
  }

  function actionFromPath(path) {
    const value = String(path || "");
    const action = value.split("/").filter(Boolean).pop() || "tool";
    const sandbox = /asdk_app|development[_ -]?sandbox/i.test(value);
    if (action === "search") return /personal_context/i.test(value) ? "Searched personal context" : "Searched";
    const label = sandbox ? SANDBOX_LABELS[action] || ACTION_LABELS[action] : ACTION_LABELS[action];
    if (label) return label;
    return sandbox ? "Used Development Sandbox" : action.replace(/[_-]+/g, " ").replace(/^./, (character) => character.toUpperCase());
  }

  function classifyBlock(text) {
    const raw = String(text || "").trim();
    if (!raw) return { kind: "empty" };
    if (/^\[Non-text visible message\]$/i.test(raw)) return { kind: "noise" };

    if (/^(?:bash\s+-lc|\/bin\/bash\s+-lc|sh\s+-lc|python(?:3)?\s+-c)\b/i.test(raw)) {
      return { kind: "activity", label: "Ran command", raw };
    }

    if (raw[0] === "{" && raw[raw.length - 1] === "}") {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object") {
          if (typeof value.path === "string" && (value.args || value.path.startsWith("/") || value.path.includes("link_"))) {
            return { kind: "activity", label: actionFromPath(value.path), raw };
          }
          const keys = Object.keys(value);
          if (keys.some((key) => /(?:^|_)search_query$/.test(key)) || Array.isArray(value.image_query)) {
            return { kind: "activity", label: "Searched the web", raw };
          }
          if (Array.isArray(value.commands)) return { kind: "activity", label: "Ran commands", raw };
          if (Array.isArray(value.files) || Array.isArray(value.read)) return { kind: "activity", label: "Read files", raw };
          if (Array.isArray(value.find)) return { kind: "activity", label: "Searched files", raw };
          if (Array.isArray(value.paths) && typeof value.query === "string") return { kind: "activity", label: "Searched tools", raw };
          if (typeof value.query === "string" && keys.every((key) => ["query", "top_k", "scope", "filters", "intent", "sort", "sort_order"].includes(key))) {
            return { kind: "activity", label: "Searched", raw };
          }
          if (Array.isArray(value.plan)) return { kind: "activity", label: "Updated task plan", raw };
          if (value.command || value.cwd || value.session_id || value.job_id) return { kind: "activity", label: "Used a tool", raw };
        }
      } catch (error) {
        // Expected parse probe: ordinary prose may be brace-delimited without
        // being a serialized tool payload. It remains visible content below.
        void error;
      }
    }

    if (/^\{\s*"(?:path|search_query|plan|command|session_id|job_id)"\s*:/s.test(raw)) {
      return { kind: "activity", label: "Used a tool", raw };
    }
    return { kind: "content" };
  }

  function svgNode(tagName, attributes) {
    const node = document.createElementNS(SVG_NS, tagName);
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
    return node;
  }

  function activityIcon() {
    const span = document.createElement("span");
    span.className = "cg-history-activity-icon mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-token-text-tertiary";
    span.setAttribute("aria-hidden", "true");
    const svg = svgNode("svg", { viewBox: "0 0 20 20", width: "20", height: "20", fill: "none", "aria-hidden": "true" });
    svg.append(
      svgNode("path", { d: "M14.9 6.2A6 6 0 1 0 16 10", stroke: "currentColor", "stroke-width": "1.55", "stroke-linecap": "round" }),
      svgNode("path", { d: "M14.9 3.9v2.7h-2.7", stroke: "currentColor", "stroke-width": "1.55", "stroke-linecap": "round", "stroke-linejoin": "round" }),
      svgNode("circle", { cx: "10", cy: "10", r: "1.35", fill: "currentColor" })
    );
    span.append(svg);
    return span;
  }

  function activityRow(label, raw) {
    const row = document.createElement("div");
    row.className = `cg-history-activity ${currentActivityClass()}`;
    if (raw) row.title = raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw;
    row.append(activityIcon());
    const inline = document.createElement("span");
    inline.className = "inline-flex items-center gap-1";
    const text = document.createElement("span");
    text.textContent = label;
    inline.append(text);
    row.append(inline);
    return row;
  }

  function splitAssistantNodes(markdown) {
    const groups = [];
    let content = [];
    const flush = () => {
      if (!content.length) return;
      groups.push({ kind: "content", nodes: content });
      content = [];
    };

    for (const node of Array.from(markdown ? markdown.children : [])) {
      const classification = classifyBlock(node.textContent);
      if (classification.kind === "noise" || classification.kind === "empty") continue;
      if (classification.kind === "activity") {
        flush();
        groups.push(classification);
      } else {
        content.push(node);
      }
    }
    flush();
    return groups;
  }

  function buildAssistantMessage(nodes, template) {
    const message = document.createElement("div");
    message.className = `cg-history-message ${template.message}`;
    const body = document.createElement("div");
    body.className = template.assistantBody;
    const markdown = document.createElement("div");
    markdown.className = `cg-history-markdown ${template.assistantMarkdown}`;
    for (const node of nodes) markdown.append(node);
    body.append(markdown);
    message.append(body);
    return message;
  }

  function enhanceUser(group, oldMessage, template) {
    const oldMarkdown = oldMessage.querySelector(".cg-history-markdown");
    const sourceText = oldMarkdown ? oldMarkdown.textContent : oldMessage.textContent;

    const grow = document.createElement("div");
    grow.className = template.grow;
    const message = document.createElement("div");
    message.className = `cg-history-message ${template.message}`;
    const body = document.createElement("div");
    body.className = template.userBody;
    const bubble = document.createElement("div");
    bubble.className = `cg-history-user-bubble ${template.userBubble}`;
    const text = document.createElement("div");
    text.className = template.userText;
    text.textContent = sourceText;
    bubble.append(text);
    body.append(bubble);
    message.append(body);
    grow.append(message);
    group.replaceChildren(grow);
  }

  function enhanceAssistant(group, oldMessage, template) {
    const markdown = oldMessage.querySelector(".cg-history-markdown");
    if (!markdown) return;
    const chunks = splitAssistantNodes(markdown);
    const grow = document.createElement("div");
    grow.className = template.grow;

    for (const chunk of chunks) {
      if (chunk.kind === "activity") grow.append(activityRow(chunk.label, chunk.raw));
      else if (chunk.nodes && chunk.nodes.length) grow.append(buildAssistantMessage(chunk.nodes, template));
    }
    group.replaceChildren(grow);
  }

  function enhanceTurn(section) {
    if (!section || section.dataset.cgFidelity === "native-v1") return;
    const role = section.dataset.cgRole === "user" ? "user" : "assistant";
    const template = templateFor(role);
    const outer = section.querySelector(":scope > .cg-history-turn-outer") || section.firstElementChild;
    const group = outer && (outer.querySelector(":scope > .cg-history-turn-width") || outer.firstElementChild);
    const oldMessage = group && group.querySelector(":scope > .cg-history-message");
    if (!outer || !group || !oldMessage) return;

    section.className = `cg-history-turn ${template.section}`;
    section.dataset.cgRole = role;
    section.dataset.cgFidelity = "native-v1";
    section.dir = "auto";
    outer.className = `cg-history-turn-outer ${template.outer}${role === "user" && !template.outer.includes("pt-3") ? " pt-3" : ""}`;
    group.className = `cg-history-turn-width ${template.group}${role === "assistant" && !template.group.includes("agent-turn") ? " agent-turn" : ""}`;

    if (role === "user") enhanceUser(group, oldMessage, template);
    else enhanceAssistant(group, oldMessage, template);
  }

  function enhancePage(page) {
    if (!page || page.dataset.cgFidelityPage === "native-v1") return page;
    page.dataset.cgFidelityPage = "native-v1";
    for (const section of page.querySelectorAll(".cg-history-turn")) enhanceTurn(section);
    return page;
  }

  function wrap(base) {
    if (!base || typeof base.create !== "function") return base;
    return {
      ...base,
      create(options) {
        const history = base.create(options);
        if (!history || typeof history.createPage !== "function") return history;
        const createPage = history.createPage.bind(history);
        history.createPage = (page) => enhancePage(createPage(page));
        return history;
      },
      enhancePage
    };
  }

  global.CGHistoryFidelity = { wrap, enhancePage };
})(globalThis);