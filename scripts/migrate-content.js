#!/usr/bin/env node
// migrate-content.js (P5) — deterministic, re-runnable converter from the canonical
// Kramdown source (contents/*.md + SUMMARY.md) to the Eleventy input tree
// (src/contents/*.md + src/SUMMARY.md). Both build artifacts are gitignored; the
// converter re-runs cleanly so upstream content fixes merge throughout the migration
// (roadmap D4). Per file, in order (roadmap P5.1):
//   1. front matter preserved verbatim (SUMMARY.md gets permalink: /SUMMARY.html);
//   2. strip {% raw %} / {% endraw %} (they only hid math from Liquid);
//   3. rewrite {{ site.baseurl }} -> '' (root-relative; HtmlBasePlugin prefixes at build);
//   4. fold leading list-item IALs to end-of-line (SUMMARY pattern -> <li class="...">);
//   5. convert markdown="1" blocks -> ::: fenced containers (census allow-list, depth
//      matched, hard error on anything unexpected);
//   6. normalise blank lines around fences and raw block wrappers so markdown-it's
//      html_block rule doesn't swallow ::: fences or math (roadmap 10a);
//   7. assert no markdown="1" / {% raw %} / {{ site. leftovers.
//
// Image IALs ({: #FigureN} on their own line) are LEFT UNFOLDED — Kramdown binds them
// to the enclosing <p> and markdown-it-attrs does the same (roadmap 10a).
//
// Usage:
//   node scripts/migrate-content.js            # write src/contents + src/SUMMARY.md
//   node scripts/migrate-content.js --check     # exit non-zero if outputs are stale
//   node scripts/migrate-content.js --verbose

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentsDir = join(repoRoot, 'contents');
const srcDir = join(repoRoot, 'src');
const srcContentsDir = join(srcDir, 'contents');
const summarySrc = join(repoRoot, 'SUMMARY.md');
const summaryOut = join(srcDir, 'SUMMARY.md');
const census = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'migration-census.json'), 'utf8'));

// Registered container names (must mirror lib/eleventy/containers.js CONTAINER_TYPES).
const CONTAINER_NAMES = new Set([
  'abstract',
  'example',
  'problem',
  'solution',
  'note',
  'interactive', // note+interactive duplicate-class divs collapse to class="interactive"
  'glossary',
  'footnote-refs',
  'figure',
  'exercise',
]);
// Anything the census measured must be a registered container (fail fast on drift).
for (const n of census.allowedContainerNames) {
  if (!CONTAINER_NAMES.has(n))
    throw new Error(`census container "${n}" is not registered in containers.js`);
}

const CHECK = process.argv.includes('--check');
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// front matter: preserved verbatim; only SUMMARY.md gets a permalink injected.
const FM_RE = /^(---\r?\n)([\s\S]*?\r?\n)(---\r?\n?)/;

function splitFrontMatter(text, file) {
  const m = text.match(FM_RE);
  if (!m) throw new Error(`${file}: no YAML front matter`);
  return { fm: m[0], inner: m[2], body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// step 5 helpers: parse an opening container tag and build its attribute blob.
const CONTAINER_OPEN_RE = /^<(div|figure)\b([^>]*?)\s+markdown="1"([^>]*?)>\s*(\{:\s*[^}]*\})?\s*$/;
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;

function parseAttrs(attrStr, ialStr) {
  const pairs = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    pairs.push([m[1] ?? m[3], m[2] ?? m[4]]);
  }
  if (ialStr) {
    const inner = ialStr
      .replace(/^\{:\s*/, '')
      .replace(/\}\s*$/, '')
      .trim();
    for (const tok of inner.split(/\s+/)) {
      if (!tok) continue;
      if (tok.startsWith('#')) pairs.push(['id', tok.slice(1)]);
      else if (tok.startsWith('.')) pairs.push(['class', tok.slice(1)]);
      else {
        const mm = tok.match(/^([^=]+)=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
        if (mm) pairs.push([mm[1], mm[2] ?? mm[3] ?? mm[4] ?? '']);
      }
    }
  }
  // Duplicate class attributes: Kramdown (like its HTML parser) keeps the LAST value, not a
  // merge — `class="note" … class="interactive"` renders `class="interactive"`. Collapse to
  // one class attribute in the FIRST class's position carrying the LAST value (parity;
  // roadmap 2.1's "merge" note was wrong, verified against the baseline).
  const classVals = pairs.filter(([k]) => k === 'class').map(([, v]) => v);
  const lastClass = classVals.length ? classVals[classVals.length - 1] : null;
  const merged = [];
  let classDone = false;
  for (const [k, v] of pairs) {
    if (k === 'class') {
      if (!classDone) {
        merged.push(['class', lastClass]);
        classDone = true;
      }
    } else merged.push([k, v]);
  }
  return merged;
}

function matchContainerOpen(trimmed, file, lineNo) {
  const m = trimmed.match(CONTAINER_OPEN_RE);
  if (!m) return null;
  const tag = m[1];
  const attrs = parseAttrs(`${m[2]} ${m[3]}`, m[4]);
  const classVal = (attrs.find(([k]) => k === 'class') || [])[1] || '';
  const firstClass = classVal.trim().split(/\s+/)[0] || '';
  const name = firstClass || (tag === 'figure' ? 'figure' : '');
  if (!CONTAINER_NAMES.has(name)) {
    throw new Error(
      `${file}:${lineNo}: markdown="1" block with unknown container "${name}" (tag <${tag}>): ${trimmed}`
    );
  }
  // Attribute blob: omit when the only attribute is class===name (containers.js default);
  // emit {} for an attribute-less <figure> so it renders <figure> not <figure class="figure">.
  let jsonPart;
  if (attrs.length === 0) jsonPart = ' {}';
  else if (attrs.length === 1 && attrs[0][0] === 'class' && attrs[0][1] === name) jsonPart = '';
  else jsonPart = ' ' + JSON.stringify(Object.fromEntries(attrs));
  return { tag, name, jsonPart };
}

// step 3b: raw HTML tables (<table>…</table>, none carry markdown="1") are verbatim in
// Kramdown, but their cells contain $$…$$ separated by blank lines; markdown-it's html_block
// rule ends at the first blank line, so the cell math would be re-parsed as kdmath. Drop
// blank lines inside a raw table region so the whole table stays one contiguous html_block.
function stripBlanksInRawTables(lines) {
  const out = [];
  let depth = 0;
  for (const line of lines) {
    if (!(depth > 0 && line.trim() === '')) out.push(line);
    depth += (line.match(/<table\b/g) || []).length - (line.match(/<\/table>/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return out;
}

// step 3c: some IALs are wrapped across lines INSIDE their quoted value (footnote-refs:
//   `…{: class="` / `  footnote-ref-link"}`). Join a line whose last `{:` has no closing
// `}` with the following line so markdown-it-attrs sees a single, parseable IAL.
function joinWrappedIALs(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const unclosed = s => {
      const k = s.lastIndexOf('{:');
      return k !== -1 && s.indexOf('}', k) === -1;
    };
    while (unclosed(line) && i + 1 < lines.length) {
      line = line.replace(/\s+$/, '') + ' ' + lines[++i].replace(/^\s+/, '');
    }
    out.push(line);
  }
  return out;
}

// step 3e: a handful of image titles contain a raw `<a href="#…">` — i.e. double quotes
// INSIDE a double-quoted title. Kramdown reads the title to the last `"` before `)` and
// escapes the inner tag; markdown-it stops at the first inner `"`, spilling a real <a> (a
// spurious link). Switch the title delimiter to single quotes (these titles contain no `'`)
// so markdown-it parses the whole title and escapes the inner `"` in the attribute.
function fixNestedQuoteTitles(line) {
  const m = line.match(/^(\s*!\[[^\]]*\]\([^\s)]+\s+)"(.*)"(\)\s*)$/);
  if (m && m[2].includes('"') && !m[2].includes("'")) return `${m[1]}'${m[2]}'${m[3]}`;
  return line;
}

// step 3d: an inline term IAL sometimes wraps to the next line AFTER its bold span:
//   `…a **parallel plate capacitor**` / `{: class="term"}. It is easy…`
// markdown-it-attrs binds a curly IAL only when it is adjacent to the inline element, so
// pull a line-initial `{: …}` back onto a previous line ending in `**` (a strong close).
function joinEmphasisIALs(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\{:[^}]*\})(.*)$/);
    if (m && out.length && /\*\*$/.test(out[out.length - 1].replace(/\s+$/, ''))) {
      out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + m[1];
      out.push(m[2].replace(/^\s+/, ''));
      continue;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// step 4: fold a leading list-item IAL to the end of the item's OWN content so it binds to
// the <li> (Kramdown places the IAL first; markdown-it-attrs wants it last).
//   "2. {: .chapter} [Intro](x.md)"  ->  "2. [Intro](x.md) {: .chapter}"
// The item may wrap across continuation lines (footnote-refs), so the IAL moves to the last
// continuation line — but NOT past a nested list item (its own IAL binds to the parent li).
function foldListItemIALs(lines) {
  const out = lines.slice();
  const LEADING = /^(\s*(?:\d+\.|[-*+]))\s+(\{:[^}]*\})\s+(\S.*)$/;
  const MARKER = /^\s*(?:\d+\.|[-*+])\s/;
  for (let i = 0; i < out.length; i++) {
    const m = out[i].match(LEADING);
    if (!m) continue;
    const [, marker, ial, rest] = m;
    const markerIndent = indentOf(marker);
    let j = i;
    while (j + 1 < out.length) {
      const nxt = out[j + 1];
      if (nxt.trim() === '' || indentOf(nxt) <= markerIndent || MARKER.test(nxt)) break;
      j++;
    }
    out[i] = `${marker} ${rest}`;
    out[j] = out[j].replace(/\s+$/, '') + ' ' + ial;
  }
  return out;
}

// step 4b: a standalone IAL (blank line before it) binds FORWARD to the next block in
// Kramdown (a "block IAL before an element"), whereas markdown-it-attrs binds a lone IAL
// backward. When that next block is a heading we fold the IAL onto the heading line so it
// binds there (e.g. `{: #Table1}` after a table -> `### Efficiency {: #Table1}` ->
// <h3 id="Table1">). An IAL with NO blank before it stays attached to its preceding block
// (image `{: #FigureN}`, `### Glossary`/`{: class="glossary-title"}`) — same in both engines.
const IAL_ONLY_RE = /^\s*(\{:\s*[^}]*\})\s*$/;
function moveForwardIALs(lines) {
  const out = lines.slice();
  for (let i = 0; i < out.length; i++) {
    const m = out[i] != null && out[i].match(IAL_ONLY_RE);
    if (!m) continue;
    const blankBefore = i === 0 || out[i - 1] == null || out[i - 1].trim() === '';
    if (!blankBefore) continue; // attached to the preceding block — leave it
    let j = i + 1;
    while (j < out.length && (out[j] == null || out[j].trim() === '')) j++;
    if (j < out.length && /^#{1,6}\s/.test(out[j])) {
      out[j] = out[j].replace(/\s+$/, '') + ' ' + m[1];
      out[i] = null;
    }
  }
  return out.filter(l => l !== null);
}

// ---------------------------------------------------------------------------
// step 5: convert markdown="1" blocks to ::: fences. Depth-matched so a container's
// closing </div>/</figure> is the one that returns to its opening nesting level, even
// when raw <div class="equation"> / <div class="title"> wrappers nest inside.
//
// markdown-it-container matches a closing fence by marker length (>= the opening's) and
// does NOT track nested opens, so a parent and child that both use ::: mis-nest. We give
// each container a colon count that is strictly greater than any container nested inside
// it: colonCount = 3 + (maxContainerDepth - depth). The innermost gets 3; every ancestor
// gets one more than its deepest descendant. Blank-line classification (step 6) accepts
// fences of any length >= 3.
const RAW_WRAPPER_OPEN = /^\s*<(?:div|section|figure)\b[^>]*[^/]>\s*$/;
const MIDLINE_BLOCK_TAG = /<\/?(?:div|figure|section)\b[^>]*>/g;
const escapeMidlineBlockTags = line =>
  line.replace(MIDLINE_BLOCK_TAG, m => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
const indentOf = s => s.match(/^[ \t]*/)[0].length;
const padTo = (s, n) => {
  const cur = indentOf(s);
  return cur < n ? ' '.repeat(n - cur) + s : s;
};

function convertContainers(body, file) {
  const lines = body.split('\n');
  const ops = []; // string (raw line) OR { fence:'open'|'close', depth, name, jsonPart }
  const contStack = []; // open CONTAINERS: { tag, level, depth }
  const rawStack = []; // indents of open RAW block wrappers (equation/title/media/section)
  let divDepth = 0;
  let figDepth = 0;
  let maxDepth = 0;
  const depthDelta = line => {
    divDepth += (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
    figDepth += (line.match(/<figure\b/g) || []).length - (line.match(/<\/figure>/g) || []).length;
  };
  // Re-indent a line into the enclosing raw wrapper (never a markdown container): a raw
  // <div class="equation"> that is a numbered list step keeps its (often un-indented)
  // $$…$$ body verbatim only if the body sits at >= the wrapper's indent, else markdown-it
  // ends the html_block at the de-indent and re-parses the $$…$$ as block kdmath. Blank
  // lines are left untouched (padding would make them non-blank).
  const reindent = line =>
    rawStack.length && line.trim() !== '' ? padTo(line, rawStack[rawStack.length - 1]) : line;

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    const co = matchContainerOpen(trimmed, file, i + 1);
    if (co) {
      const depth = contStack.length;
      maxDepth = Math.max(maxDepth, depth);
      ops.push({ fence: 'open', depth, name: co.name, jsonPart: co.jsonPart });
      if (co.tag === 'figure') contStack.push({ tag: 'figure', level: ++figDepth, depth });
      else contStack.push({ tag: 'div', level: ++divDepth, depth });
      return;
    }

    if (trimmed === '</div>' || trimmed === '</figure>' || trimmed === '</section>') {
      const tag = trimmed === '</div>' ? 'div' : trimmed === '</figure>' ? 'figure' : 'section';
      let isContainerClose = false;
      if (tag === 'div' || tag === 'figure') {
        const curLevel = tag === 'div' ? divDepth : figDepth;
        const top = contStack[contStack.length - 1];
        if (top && top.tag === tag && top.level === curLevel) {
          ops.push({ fence: 'close', depth: top.depth });
          contStack.pop();
          isContainerClose = true;
        }
        if (tag === 'div') divDepth--;
        else figDepth--;
      }
      if (!isContainerClose) {
        rawStack.pop();
        ops.push(reindent(line));
      }
      return;
    }

    // A standalone raw block-wrapper open (markdown="1" opens were handled by `co` above).
    if (RAW_WRAPPER_OPEN.test(line) && !/markdown="1"/.test(line)) {
      const padded = reindent(line);
      ops.push(padded);
      rawStack.push(indentOf(padded));
      depthDelta(line);
      return;
    }

    // Any other line: re-indent into the enclosing raw wrapper, and track mid-line raw
    // div/figure nesting by substring count so container-close matching stays accurate.
    // A block-level tag that appears MID-line (in a paragraph, not alone) is span-level
    // context for Kramdown, which escapes it to text (`<div …>` -> `&lt;div …&gt;`) while
    // rendering the $$…$$ around it inline. Escape those here so markdown-it (html:true)
    // doesn't emit a real, unbalanced element. Depth is still counted from the raw line so
    // it stays balanced with any matching alone `</div>` (which Kramdown keeps raw).
    ops.push(escapeMidlineBlockTags(reindent(line)));
    depthDelta(line);
  });

  if (contStack.length)
    throw new Error(`${file}: ${contStack.length} unclosed markdown="1" container(s)`);

  return ops.map(op => {
    if (typeof op === 'string') return op;
    const colons = ':'.repeat(3 + maxDepth - op.depth);
    return op.fence === 'open' ? `${colons} ${op.name}${op.jsonPart}` : colons;
  });
}

// ---------------------------------------------------------------------------
// step 6: blank-line normalisation. Classify each converted line and insert a blank
// between neighbours when markdown-it would otherwise merge them (roadmap 10a):
//   - always isolate ::: fences (both sides);
//   - blank BEFORE a standalone raw block-wrapper open, blank AFTER its close, so the
//     wrapper is its own html_block and following text is parsed as markdown (its math
//     becomes kdmath). Interior of a raw wrapper is left contiguous (no forced blanks).
const RAW_OPEN_RE = /^\s*<(div|section|figure)\b[^>]*[^/]>\s*$/;
const RAW_CLOSE_RE = /^\s*<\/(div|section|figure)>\s*$/;

function classify(line) {
  if (line.trim() === '') return 'blank';
  if (/^:{3,}\s+\S/.test(line)) return 'fence-open';
  if (/^:{3,}\s*$/.test(line)) return 'fence-close';
  if (RAW_CLOSE_RE.test(line)) return 'raw-close';
  if (RAW_OPEN_RE.test(line)) return 'raw-open';
  return 'content';
}

function needsBlank(prev, cur) {
  if (prev === null || prev === 'blank') return false;
  const fence = c => c === 'fence-open' || c === 'fence-close';
  // Always isolate ::: fences. After a raw block-wrapper close, force a blank so following
  // markdown (and its $$…$$ math) parses fresh instead of being swallowed by html_block.
  // We do NOT force a blank BEFORE a raw-open: an html_block already interrupts a paragraph,
  // and inserting one would break a raw wrapper that continues a list item (an indented
  // <div class="equation"> keeps its $$…$$ verbatim inside the <li> only if left attached).
  if (fence(prev) || fence(cur)) return true;
  if (prev === 'raw-close') return true;
  return false;
}

function normaliseBlanks(lines) {
  const out = [];
  let prev = null;
  for (const line of lines) {
    const cls = classify(line);
    if (cls === 'blank') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      prev = 'blank';
      continue;
    }
    if (needsBlank(prev, cls) && out.length && out[out.length - 1] !== '') out.push('');
    out.push(line);
    prev = cls;
  }
  return out;
}

// ---------------------------------------------------------------------------
function convert(text, { file, isSummary }) {
  const { fm, inner, body } = splitFrontMatter(text, file);

  // steps 2 & 3 (whole-body string rewrites).
  let b = body
    .replace(/\{%\s*raw\s*%\}/g, '')
    .replace(/\{%\s*endraw\s*%\}/g, '')
    .replace(/\{\{\s*site\.baseurl\s*\}\}/g, '');

  // steps 3b (raw-table blanks), 3c (join wrapped IALs), 4 (fold list IALs), 4b (forward
  // IALs), then 5 (containers), then 6 (blanks).
  let lines = stripBlanksInRawTables(b.split('\n'));
  lines = lines.map(fixNestedQuoteTitles);
  lines = joinWrappedIALs(lines);
  lines = joinEmphasisIALs(lines);
  lines = foldListItemIALs(lines);
  lines = moveForwardIALs(lines);
  const converted = convertContainers(lines.join('\n'), file);
  const normalised = normaliseBlanks(converted);
  let outBody = normalised.join('\n');

  // step 7: leftover assertions. HTML comments are inert and pass through both engines
  // identically (e.g. ch28's commented-out <figure markdown="1">, roadmap 10a), so strip
  // them before checking for genuinely-unconverted live tags.
  const live = outBody.replace(/<!--[\s\S]*?-->/g, '');
  for (const [re, what] of [
    [/markdown="1"/, 'markdown="1"'],
    [/\{%\s*(end)?raw\s*%\}/, '{% raw %}'],
    [/\{\{\s*site\./, '{{ site.'],
  ]) {
    if (re.test(live)) throw new Error(`${file}: leftover ${what} after conversion`);
  }

  let outFm = fm;
  if (isSummary) {
    // inject permalink into the YAML front matter (before its closing ---).
    const injected = inner.replace(/\r?\n$/, '') + '\npermalink: /SUMMARY.html\n';
    outFm = fm.replace(inner, injected);
  }
  return outFm + outBody;
}

// ---------------------------------------------------------------------------
function buildOutputs() {
  const outputs = new Map(); // absolute path -> content
  const files = readdirSync(contentsDir)
    .filter(f => f.endsWith('.md'))
    .sort();
  for (const f of files) {
    const text = readFileSync(join(contentsDir, f), 'utf8');
    outputs.set(
      join(srcContentsDir, f),
      convert(text, { file: `contents/${f}`, isSummary: false })
    );
  }
  outputs.set(
    summaryOut,
    convert(readFileSync(summarySrc, 'utf8'), { file: 'SUMMARY.md', isSummary: true })
  );
  return { outputs, contentCount: files.length };
}

function run() {
  let built;
  try {
    built = buildOutputs();
  } catch (err) {
    console.error(`ERROR ${err.message}`);
    process.exit(1);
  }
  const { outputs, contentCount } = built;

  if (CHECK) {
    let stale = 0;
    // stale = any expected file missing/different, or any extra generated .md present.
    for (const [path, content] of outputs) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
        stale++;
        if (VERBOSE) console.error(`STALE ${path}`);
      }
    }
    const expected = new Set([...outputs.keys()]);
    if (existsSync(srcContentsDir)) {
      for (const f of readdirSync(srcContentsDir)) {
        if (f.endsWith('.md') && !expected.has(join(srcContentsDir, f))) {
          stale++;
          if (VERBOSE) console.error(`EXTRA ${f}`);
        }
      }
    }
    if (stale) {
      console.error(
        `migrate-content --check: ${stale} stale/extra file(s). Run: npm run migrate:content`
      );
      process.exit(1);
    }
    console.log(`migrate-content --check: up to date (${contentCount} pages + SUMMARY.md)`);
    return;
  }

  if (!existsSync(srcContentsDir)) mkdirSync(srcContentsDir, { recursive: true });
  for (const [path, content] of outputs) writeFileSync(path, content);
  console.log(`migrate-content: wrote ${contentCount} pages + SUMMARY.md to src/`);
}

run();
