/*
 * Make AntiCurse-owned archived turns visually follow the native ChatGPT thread.
 *
 * This layer intentionally copies class names only. It never copies native IDs,
 * data-message-author-role, data-turn-id, React state, buttons, or event handlers.
 * Loaded after history-virtualized.js and before windowed.js, it wraps the
 * virtual page factory and restyles each synthetic page before it is mounted.
 */
(function (global) {
  "use strict";

  const prior = global.CGHistoryOverlay;
  if (!prior || typeof prior.create !== "function") return;

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

  const copyClass = (element, fallback) => element && typeof element.className === "string" && element.className.trim()
    ? element.className
    : fallback;

  function findNativeRole(role) {
    return document.querySelector(`#thread [data-message-author-role="${role}"]`);
  }

  function templateFor(role) {
    const message = findNativeRole(role);
    if (!message) return { ...FALLBACK };

    const section = message.closest('section[data-testid^="conversation-turn-"]');
    const group = message.closest(".group\\/turn-messages");
    const outer = group && group.parentElement;
    const grow = message.parentElement;
    const body = message.firstElementChild;
    const first = body && body.firstElementChild;

    const template = {
      ...FALLBACK,
      section: copyClass(section, FALLBACK.section),
      outer: copyClass(outer, FALLBACK.outer),
      group: copyClass(group, FALLBACK.group),
      grow: copyClass(grow, FALLBACK.grow),
      message: copyClass(message, FALLBACK.message)
    };

    if (role === "user") {
      template.userBody = copyClass(body, FALLBACK.userBody);
      template.userBubble = copyClass(first, FALLBACK.userBubble);
      template.userText = copyClass(first && first.firstElementChild, FALLBACK.userText);
    } else {
      template.assistantBody = copyClass(body, FALLBACK.assistantBody);
      template.assistantMarkdown = copyClass(first, FALLBACK.assistantMarkdown);
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
    const labels = {
      exec_command: sandbox ? "Ran command in Development Sandbox" : "Ran command",
      exec_commands: sandbox ? "Ran commands in Development Sandbox" : "Ran commands",
      read_file: sandbox ? "Read file in Development Sandbox" : "Read file",
      read_files: sandbox ? "Read files in Development Sandbox" : "Read files",
      search_project: sandbox ? "Searched Development Sandbox" : "Searched files",
      search_many: sandbox ? "Searched Development Sandbox" : "Searched files",
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
      cleanup_jobs: "Cleaned Development Sandbox jobs",
      search: /personal_context/i.test(value) ? "Searched personal context" : "Searched"
    };
    if (labels[action]) return labels[action];
    return sandbox ? "Used Development Sandbox" : action.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
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
          if (typeof value.path === "string") {
            return { kind: "activity", label: actionFromPath(value.path), raw };
          }
          if (Array.isArray(value.search_query)) return { kind: "activity", label: "Searched the web", raw };
          if (Array.isArray(value.plan)) return { kind: "activity", label: "Updated task plan", raw };
          if (value.command || value.cwd || value.session_id || value.job_id) return { kind: "activity", label: "Used a tool", raw };
        }
      } catch (_) {}
    }

    if (/^\{\s*"(?:path|search_query|plan|command|session_id|job_id)"\s*:/s.test(raw)) {
      return { kind: "activity", label: "Used a tool", raw };
    }
    return { kind: "content" };
  }

  function activityIcon() {
    const span = document.createElement("span");
    span.className = "cg-history-activity-icon mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-token-text-tertiary";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true"><path d="M14.9 6.2A6 6 0 1 0 16 10" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/><path d="M14.9 3.9v2.7h-2.7" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="1.35" fill="currentColor"/></svg>';
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

  function directElementChildren(element) {
    return Array.from(element ? element.children : []);
  }

  function splitAssistantNodes(markdown) {
    const groups = [];
    let content = [];
    const flush = () => {
      if (!content.length) return;
      groups.push({ kind: "content", nodes: content });
      content = [];
    };

    for (const node of directElementChildren(markdown)) {
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

  function enhanceUser(section, outer, group, oldMessage, template) {
    const oldMarkdown = oldMessage.querySelector(".cg-history-markdown");
    const sourceText = oldMarkdown ? oldMarkdown.innerText : oldMessage.innerText;

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

  function enhanceAssistant(section, outer, group, oldMessage, template) {
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

    if (role === "user") enhanceUser(section, outer, group, oldMessage, template);
    else enhanceAssistant(section, outer, group, oldMessage, template);
  }

  function enhancePage(page) {
    if (!page || page.dataset.cgFidelityPage === "native-v1") return page;
    page.dataset.cgFidelityPage = "native-v1";
    for (const section of page.querySelectorAll(".cg-history-turn")) enhanceTurn(section);
    return page;
  }

  global.CGHistoryOverlay = {
    ...prior,
    create(options) {
      const history = prior.create(options);
      if (!history || typeof history.createPage !== "function") return history;
      const createPage = history.createPage.bind(history);
      history.createPage = function (page) {
        return enhancePage(createPage(page));
      };
      return history;
    },
    enhancePage
  };
})(globalThis);
