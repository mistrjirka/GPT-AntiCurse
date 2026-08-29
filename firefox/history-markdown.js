/* Lightweight Markdown renderer used by archived history. */
(function (global) {
  "use strict";

  const RICH_START = "\uE200";
  const RICH_SEP = "\uE202";
  const RICH_END = "\uE201";

  function markdownLink(label, href) {
    const text = String(label || "Link").replace(/[\[\]]/g, "").trim() || "Link";
    const rawHref = String(href || "").trim();
    if (/^sandbox:\/mnt\/data\//i.test(rawHref)) return `[${text}](${rawHref})`;
    try {
      const base = typeof location !== "undefined" && location?.href ? location.href : "https://chatgpt.com/";
      const url = new URL(rawHref, base);
      if (!/^https?:$/.test(url.protocol)) return text;
      return `[${text}](${url.href})`;
    } catch (error) {
      void error;
      return text;
    }
  }

  function richEntityName(value) {
    try {
      const parsed = JSON.parse(String(value || ""));
      if (Array.isArray(parsed) && typeof parsed[1] === "string") return parsed[1];
      if (parsed && Array.isArray(parsed.selections)) {
        const names = parsed.selections.map((item) => Array.isArray(item) && typeof item[1] === "string" ? item[1] : "").filter(Boolean);
        return names.length ? names.join(", ") : "";
      }
    } catch (error) {
      void error;
    }
    return "";
  }

  function projectRichToken(kind, body) {
    const parts = body == null ? [] : String(body).split(RICH_SEP);
    switch (String(kind || "").toLowerCase()) {
      case "cite":
      case "filecite":
      case "memcite":
        return "";
      case "url":
        return markdownLink(parts[0], parts[1]);
      case "entity":
      case "product":
      case "products":
        return richEntityName(parts[0]) || "[Rich item from original response]";
      case "video":
        return String(parts[0] || "Video from original response");
      case "navlist":
        return String(parts[0] || "Related sources");
      case "image_group":
        return "[Images from original response]";
      case "genui":
        return "[Interactive content from original response]";
      default:
        return "[Rich content from original response]";
    }
  }

  function projectRichTokens(source) {
    const token = new RegExp(`${RICH_START}([A-Za-z_]+)(?:${RICH_SEP}([\\s\\S]*?))?${RICH_END}`, "g");
    return String(source || "").replace(token, (_match, kind, body) => projectRichToken(kind, body));
  }

  function appendInline(parent, source, context = {}) {
    const text = String(source || "");
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:sandbox:\/mnt\/data\/[^)\n]+|[^\s)]+)\))/g;
    let at = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > at) parent.append(document.createTextNode(text.slice(at, match.index)));
      const token = match[0];
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
        if (/^sandbox:\/mnt\/data\//i.test(rawHref)) {
          const messageId = String(context.messageId || "").trim();
          const anchor = document.createElement("a");
          anchor.href = "#";
          anchor.className = "cg-history-artifact-link";
          anchor.textContent = label;
          anchor.dataset.cgSandboxPath = rawHref.replace(/^sandbox:/i, "");
          if (messageId) anchor.dataset.cgMessageId = messageId;
          anchor.title = messageId
            ? "Download archived ChatGPT file"
            : "Archived file reference is missing its original message ID";
          parent.append(anchor);
        } else {
          try {
            const base = typeof location !== "undefined" && location?.href ? location.href : "https://chatgpt.com/";
            const url = new URL(rawHref, base);
            if (/^https?:$/.test(url.protocol)) {
              const anchor = document.createElement("a");
              anchor.href = url.href;
              anchor.target = "_blank";
              anchor.rel = "noopener noreferrer";
              anchor.textContent = label;
              parent.append(anchor);
            } else {
              parent.append(document.createTextNode(label));
            }
          } catch (error) {
            void error;
            parent.append(document.createTextNode(label));
          }
        }
      }
      at = match.index + token.length;
    }
    if (at < text.length) parent.append(document.createTextNode(text.slice(at)));
  }

  function cells(line) {
    const value = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return value.split("|").map((part) => part.trim());
  }

  function divider(line) {
    const values = cells(line);
    return values.length > 1 && values.every((part) => /^:?-{3,}:?$/.test(part));
  }

  function renderMarkdown(root, source, context = {}) {
    const lines = projectRichTokens(source).replace(/\r\n?/g, "\n").split("\n");
    let index = 0;

    while (index < lines.length) {
      if (!lines[index].trim()) {
        index++;
        continue;
      }

      let match = lines[index].match(/^\s*```([^`]*)$/);
      if (match) {
        const language = match[1].trim();
        const body = [];
        for (index++; index < lines.length && !/^\s*```\s*$/.test(lines[index]); index++) body.push(lines[index]);
        if (index < lines.length) index++;
        const pre = document.createElement("pre");
        pre.className = "cg-history-code";
        const code = document.createElement("code");
        if (language) code.dataset.language = language;
        code.textContent = body.join("\n");
        pre.append(code);
        root.append(pre);
        continue;
      }

      match = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (match) {
        const heading = document.createElement(`h${match[1].length}`);
        appendInline(heading, match[2], context);
        root.append(heading);
        index++;
        continue;
      }

      if (index + 1 < lines.length && lines[index].includes("|") && divider(lines[index + 1])) {
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const row = document.createElement("tr");
        for (const value of cells(lines[index])) {
          const cell = document.createElement("th");
          appendInline(cell, value, context);
          row.append(cell);
        }
        head.append(row);
        table.append(head);
        index += 2;

        const body = document.createElement("tbody");
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          const bodyRow = document.createElement("tr");
          for (const value of cells(lines[index++])) {
            const cell = document.createElement("td");
            appendInline(cell, value, context);
            bodyRow.append(cell);
          }
          body.append(bodyRow);
        }
        table.append(body);
        root.append(table);
        continue;
      }

      if (/^\s*>\s?/.test(lines[index])) {
        const quote = document.createElement("blockquote");
        const quoteLines = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoteLines.push(lines[index++].replace(/^\s*>\s?/, ""));
        }
        renderMarkdown(quote, quoteLines.join("\n"), context);
        root.append(quote);
        continue;
      }

      match = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
      if (match) {
        const ordered = /^\d/.test(match[1]);
        const list = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const row = document.createElement("li");
          appendInline(row, item[2], context);
          list.append(row);
          index++;
        }
        root.append(list);
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim()) {
        if (paragraph.length && (
          /^\s*```/.test(lines[index]) ||
          /^\s{0,3}#{1,6}\s+/.test(lines[index]) ||
          /^\s*>\s?/.test(lines[index]) ||
          /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])
        )) break;
        if (index + 1 < lines.length && lines[index].includes("|") && divider(lines[index + 1])) break;
        paragraph.push(lines[index++]);
      }

      if (paragraph.length) {
        const node = document.createElement("p");
        paragraph.forEach((line, lineIndex) => {
          if (lineIndex) node.append(document.createElement("br"));
          appendInline(node, line, context);
        });
        root.append(node);
      } else {
        index++;
      }
    }
  }

  const api = Object.freeze({ renderMarkdown, projectRichTokens });
  global.CGHistoryMarkdown = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
