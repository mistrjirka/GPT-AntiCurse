/* Markdown export views for conversation archives. */
(function (global) {
  "use strict";

  const DEFAULT_EXPORT_LEVEL = "progress";
  const EXPORT_LEVELS = new Set(["clean", "progress", "full"]);
  const EXPORT_DESCRIPTIONS = Object.freeze({
    clean: "Clean — user tasks and final visible assistant responses",
    progress: "Progress — visible assistant progress and consolidated plans; tool calls omitted",
    full: "Full — visible assistant records, structured plans, and explicit tool calls"
  });
  const COMPLETED_PLAN_STATUSES = new Set(["completed", "complete", "done"]);
  const ACTIVE_PLAN_STATUSES = new Set(["in_progress", "in-progress", "active"]);
  const TOOL_JSON_KEYS = new Set([
    "search_query", "image_query", "open", "click", "find", "screenshot",
    "calculator", "weather", "finance", "sports", "product_query",
    "businesses_query", "availability_query", "commands"
  ]);

  function normalizeText(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
  }

  function normalizeOneLine(value, fallback = "") {
    const result = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return result || fallback;
  }

  function resolveExportLevel(options) {
    const value = typeof options === "string" ? options : options && options.level;
    return EXPORT_LEVELS.has(value) ? value : DEFAULT_EXPORT_LEVEL;
  }

  function parseJsonPayload(value) {
    const raw = normalizeText(value);
    if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function extractPlanPayload(message) {
    const value = parseJsonPayload(message && message.text);
    if (!value || Array.isArray(value) || !Array.isArray(value.plan)) return null;
    const steps = value.plan
      .filter((item) => item && typeof item.step === "string" && item.step.trim())
      .map((item) => ({
        step: item.step.trim(),
        status: normalizeOneLine(item.status, "pending").toLowerCase()
      }));
    if (!steps.length) return null;
    return {
      steps,
      explanation: typeof value.explanation === "string" ? value.explanation.trim() : ""
    };
  }

  function extractToolPayload(value) {
    const parsed = parseJsonPayload(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    if (typeof parsed.path === "string" && Object.prototype.hasOwnProperty.call(parsed, "args")) return parsed;
    for (const key of Object.keys(parsed)) if (TOOL_JSON_KEYS.has(key)) return parsed;
    return null;
  }

  function looksLikeShellCommand(value) {
    const raw = normalizeText(value);
    return /^(?:bash|sh|zsh)\s+/.test(raw) ||
      /^(?:python(?:3)?|node|curl|wget|git|gh|cmake|ninja|rg|sed|awk)\s+/.test(raw);
  }

  function isToolRecipient(message) {
    const recipient = normalizeOneLine(message && message.recipient).toLowerCase();
    return !!recipient && recipient !== "all" && recipient !== "assistant";
  }

  function classifyAssistantMessage(message) {
    const plan = extractPlanPayload(message);
    if (plan) return { kind: "plan", plan };
    const parsedTool = extractToolPayload(message && message.text);
    if (isToolRecipient(message) || parsedTool || looksLikeShellCommand(message && message.text)) {
      return { kind: "tool", parsedTool };
    }
    return { kind: "narrative" };
  }

  function toolCallLabel(message, classification) {
    const recipient = normalizeOneLine(message && message.recipient);
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
    return looksLikeShellCommand(message && message.text) ? "shell" : "tool";
  }

  function codeFence(value) {
    const raw = normalizeText(value);
    const language = parseJsonPayload(raw) ? "json" : looksLikeShellCommand(raw) ? "bash" : "text";
    const marker = raw.includes("````") ? "`````" : raw.includes("```") ? "````" : "```";
    return `${marker}${language}\n${raw}\n${marker}`;
  }

  function appendLabel(lines, label) {
    lines.push(`**${label}**`, "");
  }

  function appendPlan(lines, plan, label) {
    appendLabel(lines, label);
    if (plan.explanation) lines.push(plan.explanation, "");
    for (const item of plan.steps) {
      if (COMPLETED_PLAN_STATUSES.has(item.status)) {
        lines.push(`- [x] ${item.step}`);
      } else if (ACTIVE_PLAN_STATUSES.has(item.status)) {
        lines.push(`- [ ] **In progress:** ${item.step}`);
      } else {
        lines.push(`- [ ] ${item.step}`);
      }
    }
    lines.push("");
  }

  function groupByUserTurn(messages) {
    const groups = [];
    let currentGroup = null;
    for (const message of messages) {
      const body = normalizeText(message && message.text);
      if (!message || !body) continue;
      if (message.role === "user") {
        currentGroup = { user: body, assistant: [] };
        groups.push(currentGroup);
      } else if (message.role === "assistant" && currentGroup) {
        currentGroup.assistant.push({ ...message, text: body });
      }
    }
    return groups;
  }

  function analyzeAssistantEntries(group) {
    const entries = group.assistant.map((message) => ({ message, classification: classifyAssistantMessage(message) }));
    const narratives = entries.filter((entry) => entry.classification.kind === "narrative");
    const plans = entries.filter((entry) => entry.classification.kind === "plan");
    return {
      entries,
      narratives,
      response: narratives.length ? narratives[narratives.length - 1] : null,
      plan: plans.length ? plans[plans.length - 1].classification.plan : null
    };
  }

  function renderCleanGroup(lines, group) {
    const analysis = analyzeAssistantEntries(group);
    lines.push("## User", "", group.user, "");
    if (analysis.response) lines.push("## Assistant", "", analysis.response.message.text, "");
  }

  function renderProgressGroup(lines, group) {
    const analysis = analyzeAssistantEntries(group);
    lines.push("## User", "", group.user, "");
    if (!analysis.narratives.length && !analysis.plan) return;
    lines.push("## Assistant", "");
    const updates = analysis.response ? analysis.narratives.slice(0, -1) : analysis.narratives;
    if (updates.length) {
      appendLabel(lines, "Progress");
      for (const entry of updates) lines.push(entry.message.text, "");
    }
    if (analysis.plan) appendPlan(lines, analysis.plan, "Plan");
    if (analysis.response) {
      if (updates.length || analysis.plan) appendLabel(lines, "Response");
      lines.push(analysis.response.message.text, "");
    }
  }

  function renderFullGroup(lines, group) {
    const analysis = analyzeAssistantEntries(group);
    lines.push("## User", "", group.user, "");
    if (!analysis.entries.length) return;
    lines.push("## Assistant", "");
    let progressOpen = false;
    for (const entry of analysis.entries) {
      const { message, classification } = entry;
      if (classification.kind === "narrative") {
        if (entry === analysis.response) {
          if (analysis.entries.length > 1) appendLabel(lines, "Response");
          lines.push(message.text, "");
          progressOpen = false;
        } else {
          if (!progressOpen) appendLabel(lines, "Progress");
          lines.push(message.text, "");
          progressOpen = true;
        }
      } else if (classification.kind === "plan") {
        progressOpen = false;
        appendPlan(lines, classification.plan, "Plan update");
        lines.push("<details>", "<summary>Raw plan payload</summary>", "", codeFence(message.text), "", "</details>", "");
      } else {
        progressOpen = false;
        appendLabel(lines, `Tool call — ${toolCallLabel(message, classification)}`);
        lines.push(codeFence(message.text), "");
      }
    }
  }

  function archiveToMarkdown(archive, options = {}) {
    if (!archive) return "";
    const level = resolveExportLevel(options);
    const lines = [
      `# ${normalizeOneLine(archive.title, "ChatGPT conversation")}`,
      "",
      `> Exported by GPT AntiCurse on ${archive.updatedAt || new Date().toISOString()}.`,
      `> Original conversation: ${archive.sourceUrl || "https://chatgpt.com/"}`,
      `> Export detail: ${EXPORT_DESCRIPTIONS[level]}.`
    ];
    if (archive.complete === false) {
      lines.push("> Warning: this export snapshot was reconstructed from currently rendered turns and may not contain older unloaded history.");
    }
    lines.push("", "---", "");
    for (const group of groupByUserTurn(Array.isArray(archive.messages) ? archive.messages : [])) {
      if (level === "clean") renderCleanGroup(lines, group);
      else if (level === "progress") renderProgressGroup(lines, group);
      else renderFullGroup(lines, group);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const api = {
    DEFAULT_EXPORT_LEVEL,
    EXPORT_LEVELS,
    archiveToMarkdown,
    classifyAssistantMessage,
    planPayload: extractPlanPayload
  };

  global.CGArchiveExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
