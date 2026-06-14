export function markdownToHtml(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  let listTag;
  let inCode = false;
  let codeBuffer = [];

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (line.startsWith("# ")) {
      closeList();
      html.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("- ")) {
      openList("ul");
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      openList("ol");
      html.push(`<li>${inline(line.replace(/^\d+\. /, ""))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }

  closeList();
  return html.join("\n");

  function openList(tag) {
    if (listTag === tag) return;
    closeList();
    html.push(`<${tag}>`);
    listTag = tag;
  }

  function closeList() {
    if (!listTag) return;
    html.push(`</${listTag}>`);
    listTag = undefined;
  }
}

function inline(value) {
  const code = [];
  let output = value.replace(/`([^`]+)`/g, (_, content) => {
    code.push(`<code>${escapeHtml(content)}</code>`);
    return `%%CRABFLEET_CODE_SPAN_${code.length - 1}%%`;
  });
  output = escapeHtml(output)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, href) => `<a href="${workerDocsHref(href)}">${label}</a>`,
    )
    .replace(/&lt;(https?:\/\/[^\s<>]+)&gt;/g, '<a href="$1">$1</a>');
  return output.replace(/%%CRABFLEET_CODE_SPAN_(\d+)%%/g, (_, index) => code[Number(index)]);
}

function workerDocsHref(href) {
  if (href === "/spec/" || href === "/spec") return "/docs/spec";
  if (href === "/spec-v2/" || href === "/spec-v2") return "/docs/spec-v2";
  if (href.startsWith("/")) return `https://docs.crabfleet.ai${href}`;
  if (/^(https?:|mailto:|tel:|#)/.test(href)) return href;
  return "#";
}

export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
