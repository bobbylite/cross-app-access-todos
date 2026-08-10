// A small, safe markdown subset for the agent's replies.
//
// Everything is escaped *before* any markdown syntax is interpreted, so nothing the
// model writes — and nothing it echoes back from a todo title or an error string — can
// inject a real tag. The markdown transforms below only ever introduce tags we chose.
//
// Re-run on every streamed chunk, on the accumulated text so far. A `**` with no
// closing pair yet just doesn't match and shows as literal asterisks until its partner
// arrives — a little flicker mid-stream, but it always converges to the right thing,
// and that's a better trade than trying to parse a markdown fragment that isn't
// finished yet.

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Same trick as TRACE_PREFIX in app.js: a NUL byte the model can never produce through
// ordinary generation, so it can't collide with real text the way a plain marker like
// " B0 " could (a todo title that happens to contain "B0", a scope name, anything).
const NUL = "\u0000";

export function renderMarkdownLite(raw) {
  if (!raw) return "";

  let text = escapeHtml(raw);

  // Fenced and inline code come out first, into placeholders, so nothing below —
  // emphasis, links, list detection — reaches inside a code span and mangles it.
  // Anchored to the start of a line (CommonMark's actual rule for a fence) rather than
  // matching ``` anywhere — otherwise "Then ```\ncode\n``` end." reads as one line with
  // an inline placeholder, and the block-placeholder check below can't tell it apart
  // from a real inline span, so it ends up nested inside a <p> again regardless.
  const blocks = [];
  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return `${NUL}B${blocks.length - 1}${NUL}`;
  });

  const spans = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `${NUL}C${spans.length - 1}${NUL}`;
  });

  // Bold before italic, so **x** isn't half-consumed by the single-marker pass.
  // Deliberately no lookbehind (older-engine-safe): the `[^\s*]` guard on the
  // opening character already keeps a bare "3 * 4" from being read as emphasis,
  // since there's a space right after that first asterisk.
  text = text
    .replace(/\*\*([^\s*][^\n]*?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^\s_][^\n]*?)__/g, "<strong>$1</strong>")
    .replace(/\*([^\s*][^\n]*?)\*/g, "<em>$1</em>")
    .replace(/_([^\s_][^\n]*?)_/g, "<em>$1</em>");

  // Only http(s) and relative paths become a real link. Anything else (javascript:,
  // data:) is left as the escaped, inert text it already is.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    if (!/^https?:\/\//.test(url) && !url.startsWith("/")) return whole;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Block structure: group consecutive list lines, wrap everything else in
  // paragraphs, and turn single newlines inside a paragraph into <br>.
  const lines = text.split("\n");
  const out = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`,
      );
      list = null;
    }
  };

  const blockPlaceholder = new RegExp(`^${NUL}B(\\d+)${NUL}$`);

  for (const line of lines) {
    // A fenced code block is its own top-level unit. Left to fall into the paragraph
    // accumulator below, it would end up as <p>text<pre>…</pre>text</p> — a block
    // element inside a <p>, which the browser silently repairs by splitting the
    // paragraph in two, leaving the DOM structure not matching this function's output.
    if (blockPlaceholder.test(line.trim())) {
      flushList();
      flushPara();
      out.push(line.trim());
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);

    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? numbered)[1]);
      continue;
    }

    flushList();
    if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushList();
  flushPara();

  let html = out.join("");

  // Put the protected spans back. The content was escaped once, up front — this is
  // a straight substitution, not a second pass over anything user- or model-supplied.
  const codeRestore = new RegExp(`${NUL}C(\\d+)${NUL}`, "g");
  const blockRestore = new RegExp(`${NUL}B(\\d+)${NUL}`, "g");
  html = html.replace(codeRestore, (_, i) => `<code>${spans[Number(i)]}</code>`);
  html = html.replace(
    blockRestore,
    (_, i) => `<pre><code>${blocks[Number(i)]}</code></pre>`,
  );

  return html;
}
