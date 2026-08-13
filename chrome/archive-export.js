/* Markdown export views for conversation archives. */
(function (global) {
  "use strict";

  const A = global.CGArchive;
  if (!A) return;

  const EXPORT_LEVELS = new Set(["clean", "progress", "full"]);
  const TOOL_JSON_KEYS = new Set([
    "search_query", "image_query", "open", "click", "find", "screenshot",
    "calculator", "weather", "finance", "sports", "product_query",
    "businesses_query", "availability_query", "commands"
  ]);

  function text(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
  }

  function oneLine(value, fallback = "") {
    const result = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return result || fallback;
  }

  function levelOf(options) {
    const value = typeof options === "string" ? options : options && options.level;
    return EXPORT_LEVELS.has(value) ? value : "clean";
  }

  function parseJson(value) {
    const raw = text(value);
    if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function planPayload(message) {
    const value = parseJson(message && message.text);
    if (!value || Array.isArray(value) || !Array.isArray(value.plan)) return null;
    const steps = value.plan
      .filter((item) => item && typeof item.step === "string" && item.step.trim())
      .map((item) => ({
        step: item.step.trim(),
        status: oneLine(item.status, "pending").toLowerCase()
      }));
    if (!steps.length) return null;
    return {
      steps,
      explanation: typeof value.explanation === "string" ? value.explanation.trim() : ""
    };
  }

  function toolJson(value) {
    const parsed = parseJson(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    if (typeof parsed.path === "string" && Object.prototype.hasOwnProperty.call(parsed, "args")) return parsed;
    for (const key of Object.keys(parsed)) if (TOOL_JSON_KEYS.has(key)) return parsed;
    return null;
  }

  function shellLike(value) {
    const raw = text(value);
    return /^(?:bash|sh|zsh)\s+/.test(raw) ||
      /^(?:python(?:3)?|node|curl|wget|git|gh|cmake|ninja|rg|sed|awk)\s+/.test(raw);
  }

  function isToolRecipient(message) {
    const recipient = oneLine(message && message.recipient).toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function classify(message) {
    const plan = planPayload(message);
    if (plan) return { kind: "plan", plan };
    const parsedTool = toolJson(message && message.text);
    if (isToolRecipient(message) || parsedTool || shellLike(message && message.text)) {
      return { kind: "tool", parsedTool };
    }
    return { kind: "narrative" };
  }

  function toolLabel(message, classification) {
    const recipient = oneLine(message && message.recipient);
    if (recipient && recipient.toLowerCase() !== "all") return recipient;
    const parsed = classification.parsedTool;
    if (parsed && typeof parsed.path === "string") {
      const parts = parsed.path.split("/").filter(Boolean);
      return parts[parts.length - 1] || "tool";
    }
    if (parsed) {
      const key = Object.keys(parsed).find((item) => TOOL_JSON_KEYS.has(item));
      if (key) return key.replace(/_/g, " ");
    }
    return shellLike(message && message.text) ? "shell" : "tool";
  }

  function fence(value) {
    const raw = text(value);
    const language = parseJson(raw) ? "json" : shellLike(raw) ? "bash" : "text";
    const marker = raw.includes("````") ? "`````" : raw.includes("```") ? "````" : "```";
    return `${marker}${language}\n${raw}\n${marker}`;
  }

  function addPlan(lines, plan, heading) {
    lines.push(`### ${heading}`, "");
    if (plan.explanation) lines.push(plan.explanation, "");
    for (const item of plan.steps) {
      if (["completed", "complete", "done"].includes(item.status)) {
        lines.push(`- [x] ${item.step}`);
      } else if (["in_progress", "in-progress", "active"].includes(item.status)) {
        lines.push(`- [ ] **In progress:** ${item.step}`);
      } else {
        lines.push(`- [ ] ${item.step}`);
      }
    }
    lines.push("");
  }

  function groups(messages) {
    const result = [];
    let current = null;
    for (const message of messages) {
      const body = text(message && message.text);
      if (!message || !body) continue;
      if (message.role === "user") {
        current = { user: body, assistant: [] };
        result.push(current);
      } else if (message.role === "assistant" && current) {
        current.assistant.push({ ...message, text: body });
      }
    }
    return result;
  }

  function analyze(group) {
    const entries = group.assistant.map((message) => ({ message, classification: classify(message) }));
    const narratives = entries.filter((entry) => entry.classification.kind === "narrative");
    const plans = entries.filter((entry) => entry.classification.kind === "plan");
    return {
      entries,
      narratives,
      final: narratives.length ? narratives[narratives.length - 1] : null,
      plan: plans.length ? plans[plans.length - 1].classification.plan : null
    };
  }

  function clean(lines, group) {
    const info = analyze(group);
    lines.push("## User", "", group.user, "");
    if (info.final) lines.push("## Assistant", "", info.final.message.text, "");
  }

  function progress(lines, group) {
    const info = analyze(group);
    lines.push("## User", "", group.user, "");
    if (!info.narratives.length && !info.plan) return;
    lines.push("## Assistant", "");
    const updates = info.final ? info.narratives.slice(0, -1) : info.narratives;
    if (updates.length) {
      lines.push("### Progress", "");
      for (const entry of updates) lines.push(entry.message.text, "");
    }
    if (info.plan) addPlan(lines, info.plan, "Plan");
    if (info.final) {
      if (updates.length || info.plan) lines.push("### Final answer", "");
      lines.push(info.final.message.text, "");
    }
  }

  function full(lines, group) {
    const info = analyze(group);
    lines.push("## User", "", group.user, "");
    if (!info.entries.length) return;
    lines.push("## Assistant", "");
    let progressOpen = false;
    for (const entry of info.entries) {
      const { message, classification } = entry;
      if (classification.kind === "narrative") {
        if (entry === info.final) {
          if (info.entries.length > 1) lines.push("### Final answer", "");
          lines.push(message.text, "");
          progressOpen = false;
        } else {
          if (!progressOpen) lines.push("### Progress", "");
          lines.push(message.text, "");
          progressOpen = true;
        }
      } else if (classification.kind === "plan") {
        progressOpen = false;
        addPlan(lines, classification.plan, "Plan update");
        lines.push("<details>", "<summary>Raw plan payload</summary>", "", fence(message.text), "", "</details>", "");
      } else {
        progressOpen = false;
        lines.push(`### Tool call — ${toolLabel(message, classification)}`, "", fence(message.text), "");
      }
    }
  }

  function archiveToMarkdown(archive, options = {}) {
    if (!archive) return "";
    const level = levelOf(options);
    const description = level === "clean"
      ? "Clean — user tasks and final assistant answers"
      : level === "progress"
        ? "Progress — visible assistant progress and consolidated plans; tool calls omitted"
        : "Full — all non-empty assistant records, plans, and tool calls";
    const lines = [
      `# ${oneLine(archive.title, "ChatGPT conversation")}`,
      "",
      `> Exported by GPT AntiCurse on ${archive.updatedAt || new Date().toISOString()}.`,
      `> Original conversation: ${archive.sourceUrl || "https://chatgpt.com/"}`,
      `> Export detail: ${description}.`
    ];
    if (archive.complete === false) {
      lines.push("> Warning: this backup was reconstructed from currently rendered turns and may not contain older unloaded history.");
    }
    lines.push("", "---", "");
    for (const group of groups(Array.isArray(archive.messages) ? archive.messages : [])) {
      if (level === "clean") clean(lines, group);
      else if (level === "progress") progress(lines, group);
      else full(lines, group);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  A.EXPORT_LEVELS = EXPORT_LEVELS;
  A.archiveToMarkdown = archiveToMarkdown;
  A.classifyAssistantMessage = classify;
  A.planPayload = planPayload;

  if (typeof module !== "undefined" && module.exports) module.exports = A;
})(typeof globalThis !== "undefined" ? globalThis : this);
