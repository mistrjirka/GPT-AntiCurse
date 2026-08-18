/* Lightweight Markdown renderer used by archived history. */
(function (global) {
  "use strict";

  function appendInline(parent, source) {
    const text = String(source || "");
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
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
        try {
          const url = new URL(rawHref, location.href);
          if (/^https?:$/.test(url.protocol)) {
            const anchor = document.createElement("a");
            anchor.href = url.href;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.textContent = label;
            parent.append(anchor);
          } else {
            parent.append(document.createTextNode(token));
          }
        } catch (error) {
          void error;
          parent.append(document.createTextNode(token));
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

  function renderMarkdown(root, source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
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
        appendInline(heading, match[2]);
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
          appendInline(cell, value);
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
            appendInline(cell, value);
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
        renderMarkdown(quote, quoteLines.join("\n"));
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
          appendInline(row, item[2]);
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
          appendInline(node, line);
        });
        root.append(node);
      } else {
        index++;
      }
    }
  }

  global.CGHistoryMarkdown = { renderMarkdown };
})(globalThis);
