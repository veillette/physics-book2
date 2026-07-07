# Roadmap: Migrating `physics-book2` from Jekyll to **Eleventy v4**

This is the **implementation plan** for converting this textbook site from Jekyll
(Ruby/Kramdown) to Eleventy (Node/markdown-it). It is written so that an agent (or human)
can pick up any phase and execute it without additional research: every number in here was
**measured against this repository** (2026-07-06), every code snippet targets the actual
files in this tree, and each phase ends with checkable acceptance criteria.

**This document supersedes** `doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md` (an earlier
code-level draft that contains known errors — see [§10](#10-known-errors-in-the-superseded-draft)).
Background reading: `doc/KRAMDOWN_MIGRATION_REVIEW.md`,
`doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md`.

---

## 0. Status & prior work

This repo is a deep copy of [`veillette/physics-book`](https://github.com/veillette/physics-book),
re-homed to `veillette/physics-book2` so the conversion can proceed without touching the
original. Completed in the setup phase (site still builds with **Jekyll** today):

- Git remotes: `origin` → `veillette/physics-book2`, `upstream` → `veillette/physics-book`
  (original, full history). This repo restarted from a single root commit (`23271b5a`)
  because the old `.git` was 3.3 GB.
- Internal references rebranded to `physics-book2` (`baseurl: /physics-book2`, package
  name, hardcoded base paths in `assets/js/search.js`, `sw.js`, `scripts/*`, workflows,
  docs). Vercel URLs (`physics-book.vercel.app`) intentionally left as-is.
- Generated PDFs untracked (`assets/pdf/` gitignored) — the deploy pipeline must supply
  them (see [D6](#6-decisions)).

Everything below is the actual framework conversion, which has **not started**.

**Branch strategy:** all migration work happens on a `migrate/eleventy` branch. `main`
stays on working Jekyll until Phase 10 parity is signed off.

---

## 1. Target stack: Eleventy v4

### 1.1 Version reality (checked on npm, 2026-07-06)

| npm dist-tag | Version          | Node requirement |
| ------------ | ---------------- | ---------------- |
| `latest`     | `3.1.6`          | `>=18`           |
| `canary`     | `4.0.0-alpha.10` | `>=22.15`        |

**Decision: target Eleventy v4** (`@11ty/eleventy@canary`). Local Node is v24.14.0, which
satisfies the v4 requirement. Rationale: v4 is where 11ty development is going (async-capable
Nunjucks fork, faster incremental builds, compile cache); adopting it now avoids a second
migration later. It is prerelease software, so we hedge:

- **Install:** `npm install --save-dev @11ty/eleventy@canary`, then **pin the resolved
  version exactly** in `package.json` (e.g. `"@11ty/eleventy": "4.0.0-alpha.10"`) so builds
  are reproducible. If a v4 beta/stable exists when you execute this plan, prefer it.
- **API discipline:** use **only configuration APIs that exist identically in 3.x**
  (`setLibrary`, `addPassthroughCopy`, `addPlugin(HtmlBasePlugin)`, `addFilter`, `dir`/
  `markdownTemplateEngine`/`pathPrefix` return object). This makes the fallback a one-line
  change: `npm i -D @11ty/eleventy@^3.1.6` with **zero config edits**.
- **Fallback trigger:** if any v4-alpha bug blocks a phase for more than ~1 hour of
  debugging, fall back to 3.1.6, note the bug in this file, and continue — the plan is
  version-agnostic by construction.

### 1.2 v4 breaking changes that affect this project

(From the v4.0.0-alpha release notes; verified relevant to this repo.)

| Change in v4                                                      | Impact here                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Node `>=22.15`                                                    | **CI must bump `node-version: "20"` → `"24"`** in `ci.yml` (×3), `deploy.yml`, `link-check.yml` (×2), `generate-pdfs.yml` |
| Nunjucks replaced by `@11ty/nunjucks` fork (fully async)          | None — our layouts are trivial; standard tags only                                                                        |
| Boolean attributes render as `<input disabled>` not `disabled=""` | Normalize both forms in the parity comparator (P0.4)                                                                      |
| `page.dir` / `page.inputPathDir` removed                          | Don't use them (we don't)                                                                                                 |
| `setDataDeepMerge(false)` throws                                  | Don't use it (we don't)                                                                                                   |
| Dev server v3 (alpha)                                             | Serve on **port 4000** (`--port=4000`) so the 8 scripts that hardcode `localhost:4000` keep working                       |

### 1.3 Dependencies to add (all dev)

```bash
npm install --save-dev @11ty/eleventy@canary \
  markdown-it markdown-it-attrs markdown-it-anchor \
  markdown-it-container markdown-it-deflist markdown-it-footnote
```

- `markdown-it` (^14) — set as Eleventy's markdown library via `setLibrary` (don't rely on
  the bundled instance; we need our plugin stack on it).
- `markdown-it-deflist` — **required**: 229 content files use Kramdown definition lists
  (`: definition` lines) for glossaries.
- `markdown-it-footnote` — 1 file (`contents/ch5Elasticity.md`) uses `[^…]` footnotes.
- `markdown-it-attrs`, `markdown-it-anchor`, `markdown-it-container` — see §4.

Do **not** add `markdown-it-implicit-figures`: figures are assembled **client-side** by
`assets/js/book-viewer.js` (see §2.3); adding server-side figures would double-wrap them.

---

## 2. Current architecture (measured, 2026-07-06)

```
physics-book2/
├── _config.yml              # Jekyll config (kramdown GFM, baseurl /physics-book2)
├── Gemfile / Gemfile.lock   # Ruby deps → removed at cutover
├── _layouts/                # default.html, page.html  (trivial Liquid)
├── _includes/               # head.html (~110 lines), foot.html (Liquid partials)
├── index.html               # home page, layout: default
├── SUMMARY.md               # TOC page → builds to /SUMMARY.html (the client TOC source!)
├── sw.js                    # service worker, Jekyll front matter + {{ site.baseurl }}
├── contents/                # 282 markdown files (uniform front matter:
│                            #   title, layout: page, sectionNumber, chapterNumber)
├── assets/                  # css, js (incl. bundled MathJax at js/mathjax/), icon,
│                            #   image, manifest, pdf (gitignored), pwa
├── resources/               # 1,358 figure/image assets
├── summary.json             # nav data — a TOP-LEVEL ARRAY of chapters
├── search_index.json        # committed search index (regenerated in CI from _site)
├── scripts/                 # ~40 Node maintenance/QA scripts (framework-agnostic,
│                            #   except the ones listed in §7)
└── tests/                   # vitest: check-links, check-math, check-orphans, parse-summary
```

### 2.1 Content patterns that drive the work (counted)

| Pattern                                           |     Count | Files | Handling                                       |
| ------------------------------------------------- | --------: | ----: | ---------------------------------------------- |
| Kramdown attribute lists `{: #id}` / `{: .class}` |     1,774 |   279 | §4.2 (markdown-it-attrs + IAL folding)         |
| `markdown="1"` HTML blocks                        |     6,940 |   269 | §4.3 (preprocess to fenced containers)         |
| — of which `<div>`                                |     6,909 |       | container conversion                           |
| — of which `<figure markdown="1">`                |        29 |       | container conversion (figure-tag container)    |
| — `<section>` / `<parameter>`                     |       1+1 |       | fix manually, don't automate                   |
| `{% raw %}…{% endraw %}` pairs                    |        58 |    13 | strip during migration (§4.4)                  |
| `{{ site.baseurl }}` in content                   |        34 |       | rewrite to root-relative (§4.4)                |
| Definition lists (`^: ` lines)                    |         — |   229 | `markdown-it-deflist`                          |
| Footnotes `[^…]`                                  |         — |     1 | `markdown-it-footnote`                         |
| GFM tables                                        |         — |    20 | native markdown-it                             |
| Math `$…$` (inline), `$$…$$` (display)            | pervasive |  most | §4.1 — **custom passthrough plugin, required** |

`markdown="1"` block class inventory (top of the census — the converter must accept exactly
this set and **fail loudly on anything new**):

```
3,155 div.problem        229 div.glossary       28 figure
2,043 div.solution       ~440 div.note (with data-label / data-has-label variants)
  386 div.example         16 div.footnote-refs
  247 div.abstract        (+ data-element-type / data-print-placement attrs on many)
```

Known data quirks the converter must handle:

- Duplicate `class` attributes: `<div class="note" data-has-label="true" class="interactive" …>`
  (37 occurrences) — merge into one class list (`note interactive`).
- One same-line IAL after an opening tag: `<div class="example" markdown="1">{: #calculatingTheEffectOfMass}`
  — fold the id into the container's attributes.

### 2.2 Math (exact conventions from `assets/js/math-config.js`)

MathJax is **self-hosted** (`assets/js/mathjax/tex-chtml.js`) and renders **client-side**:

- inline: `$…$` and `\(…\)`
- display: `$$…$$` and `\[…\]`
- `processEscapes: true`, custom macros (`\KE`, `\vb`, …)

Kramdown natively recognizes `$$…$$` and shields its contents; markdown-it does **not** —
it will apply backslash-escapes (`\\` → `\`, fatal for LaTeX arrays) and emphasis parsing
inside math. This is why §4.1 is mandatory, not optional.

### 2.3 Client-side rendering contract (do not break)

`assets/js/book-viewer.js` builds the reading UI at runtime and imposes these **hard
requirements on the built HTML** (all verified in source):

1. **TOC**: fetched from `{baseHref}/SUMMARY.html` → the Eleventy build **must** emit
   `/SUMMARY.html` (Jekyll builds it from root `SUMMARY.md`).
2. **Figures**: `newPageBeforeRender()` wraps every `img[title]` in a `<figure>`, builds the
   `<figcaption>` from the `title` attribute, and **moves the `id` from the `<img>` to the
   figure** (`img.getAttribute('id')`). ⇒ the `{: #FigureN}` IALs **must land on the
   `<img>` element**, which is exactly what markdown-it-attrs does when the IAL is folded
   inline: `![alt](src 'title'){: #Figure1}`.
3. **`.md` links**: the viewer rewrites `a[href$=".md"]` → `.html` at runtime — do **not**
   rewrite content links at build time (parity).
4. `window.Book` (inline script in `head.html`) needs `rootUrl`/`baseHref` **without** a
   trailing slash (they get concatenated with `/SUMMARY.html` etc.).
5. Search fetches `{base}/search_index.json`; the PWA caches `/SUMMARY.html`, asset paths,
   and `search_index.json` (see `sw.js` `CORE_CACHE_FILES`).

### 2.4 Output-path contract (D5 — hard requirement)

Jekyll maps `contents/x.md → contents/x.html`, `SUMMARY.md → SUMMARY.html`. Eleventy's
default is `x.md → x/index.html`, so permalinks must be overridden (P2.3). Every existing
URL, anchor, PDF link, and the search index depend on this mapping.

---

## 3. Target architecture

### 3.1 During migration (parallel phase — Jekyll stays green)

```
physics-book2/
├── eleventy.config.js           # NEW (committed)
├── lib/eleventy/                # NEW: markdown-it-math-passthrough.js, kramdown-slugify.js,
│   │                            #      containers.js (committed, unit-tested)
├── src/                         # NEW Eleventy input tree
│   ├── _data/site.js            # replaces _config.yml site.* values
│   ├── _includes/head.njk foot.njk
│   ├── _includes/layouts/default.njk page.njk
│   ├── index.njk  SUMMARY.md  sw.njk         # migrated root pages (committed)
│   └── contents/                # GENERATED by scripts/migrate-content.js — GITIGNORED
├── contents/                    # canonical Kramdown source (unchanged until cutover)
├── assets/ resources/           # unchanged; passthrough-copied from repo root
├── _site/                       # Eleventy output (already gitignored)
└── _site_jekyll_baseline/       # frozen Jekyll build for parity diffs — GITIGNORED
```

Key idea: **`src/contents/` is a build artifact until cutover.** The canonical source stays
Kramdown; `scripts/migrate-content.js` is deterministic and re-runnable, so upstream content
fixes merge cleanly throughout the migration, and _both_ site builds stay green on every
commit of the branch. Jekyll ignores the new files via `_config.yml` `exclude:` additions;
Eleventy sees only `src/` + explicit passthrough mappings.

### 3.2 Final state (after P10 cutover)

```
physics-book2/
├── eleventy.config.js           # dir.input flips 'src' → '.'
├── .eleventyignore              # README.md, CONTRIBUTE.md, doc/, scripts/, tests/, …
├── _includes/                   # head.njk, foot.njk, layouts/{default,page}.njk
├── _data/site.js
├── index.njk  SUMMARY.md  sw.njk
├── contents/                    # converted markdown, committed (replaces Kramdown source)
├── assets/ resources/ summary.json search_index.json
└── (deleted: Gemfile, Gemfile.lock, _config.yml, _layouts/, old _includes/*.html,
    index.html, sw.js, src/, scripts/migrate-content.js retired)
```

Content returns to root `contents/` so the ~40 maintenance scripts (which read
`contents/*.md` from the repo root) keep working without path changes.

---

## 4. The four hard problems (everything else is mechanical)

### 4.1 Math must pass through markdown-it untouched — custom plugin (REQUIRED)

**Why:** markdown-it applies CommonMark backslash-escapes and emphasis _inside_ `$…$`/
`$$…$$` spans. `\\` (the LaTeX row separator) becomes `\`, destroying every
`\begin{array}…\end{array}`; `*x*` inside math becomes `<em>`. Kramdown shielded `$$…$$`
natively, which is why the content works today.

**Solution:** `lib/eleventy/markdown-it-math-passthrough.js` — a small plugin that claims
math spans as opaque tokens _before_ other inline rules run, and renders them **verbatim
(HTML-escaped)** for client-side MathJax:

```js
// lib/eleventy/markdown-it-math-passthrough.js
// Claims $…$, $$…$$, \(…\), \[…\] spans so no markdown rule touches their contents.
// Rendered as escapeHtml(original text) — MathJax reads textContent, so escaping is safe.
export default function mathPassthrough(md) {
  // ---- block rule: a line starting with $$ …(anything)… up to a line ending with $$
  md.block.ruler.before(
    'fence',
    'math_block',
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      if (state.src.slice(start, start + 2) !== '$$') return false;
      let line = startLine;
      let found = state.src
        .slice(start + 2, state.eMarks[startLine])
        .trimEnd()
        .endsWith('$$');
      while (!found && ++line <= endLine) {
        if (
          state.src
            .slice(state.bMarks[line], state.eMarks[line])
            .trimEnd()
            .endsWith('$$')
        )
          found = true;
      }
      if (!found) return false;
      if (silent) return true;
      const token = state.push('math_block', 'math', 0);
      token.content = state.getLines(
        startLine,
        line + 1,
        state.tShift[startLine],
        false
      );
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    }
  );

  // ---- inline rule: $…$ (pandoc-style: no space after opener / before closer,
  // closer not followed by a digit) and $$…$$ ; also \(…\) and \[…\]
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    let open, close;
    if (src.startsWith('$$', pos)) {
      open = close = '$$';
    } else if (src[pos] === '$') {
      open = close = '$';
    } else if (src.startsWith('\\(', pos)) {
      open = '\\(';
      close = '\\)';
    } else if (src.startsWith('\\[', pos)) {
      open = '\\[';
      close = '\\]';
    } else return false;
    const contentStart = pos + open.length;
    if (open === '$' && /\s/.test(src[contentStart] ?? '')) return false;
    const end = src.indexOf(close, contentStart);
    if (end === -1 || end === contentStart) return false;
    if (
      open === '$' &&
      (/\s/.test(src[end - 1]) || /\d/.test(src[end + close.length] ?? ''))
    )
      return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = src.slice(pos, end + close.length);
    }
    state.pos = end + close.length;
    return true;
  });

  md.renderer.rules.math_block = (tokens, i) =>
    md.utils.escapeHtml(tokens[i].content) + '\n';
  md.renderer.rules.math_inline = (tokens, i) =>
    md.utils.escapeHtml(tokens[i].content);
}
```

**Mandatory fixture tests** (vitest, `tests/markdown-pipeline.test.js`) — the plugin is done
only when all of these render byte-identical math text content:

- `$x_1 + y_2$` (underscores survive)
- `$$\begin{array}{ll} a & b \\ c & d \end{array}$$` (multi-line block; `\\` and `&` survive)
- `$v^*$ and $a*b*c$` (asterisks survive)
- `costs $5 and $10 total` (**not** treated as math — digit rule)
- `\(\theta_r\)` and `\[\vec{F} = m\vec{a}\]`
- math inside a `::: example` container and inside a table cell

### 4.2 Kramdown attribute lists (IALs) — `markdown-it-attrs` + folding (1,774×)

- Plugin config: `{ leftDelimiter: '{:', rightDelimiter: '}', allowedAttributes: ['id', 'class', 'height', 'width', /^data-.*$/] }`.
- **Kramdown places block IALs on the line after the element; markdown-it-attrs wants them
  inline.** The migration script folds a `{: … }` line up onto the previous line:
  - after an image paragraph → fold with **no space**: `![alt](src 'title'){: #Figure1}`
    (binds to the `<img>` — required by the runtime figure builder, §2.3-2).
  - leading IAL inside a list item (`1. {: .chapter} [Title](file.md)` — the SUMMARY.md
    pattern) → move to **end of line with a space**: `1. [Title](file.md) {: .chapter}`
    (end-of-line attrs bind to the `<li>` in markdown-it-attrs).
- **Heading auto-IDs:** Jekyll/Kramdown auto-generates heading ids (`auto_ids`, on by
  default) and cross-references may rely on them. Use `markdown-it-anchor` with a slugifier
  that replicates Kramdown's algorithm:

```js
// lib/eleventy/kramdown-slugify.js — Kramdown auto_id algorithm
export function kramdownSlugify(text) {
  const id = text
    .replace(/[^a-zA-Z0-9 -]/g, '') // drop everything but letters, digits, spaces, dashes
    .replace(/^[^a-zA-Z]+/, '') // strip up to the first letter
    .replace(/ +/g, '-')
    .toLowerCase();
  return id || 'section';
}
```

Validate with the parity comparator (P0.4 diffs every heading id) and `npm run check:cross-refs`.

- **Verify:** zero literal `{:` in any built HTML (grep `_site`, CI gate in P9).

### 4.3 `markdown="1"` blocks → fenced containers (6,940×)

Kramdown re-parses markdown inside `<div … markdown="1">`; markdown-it passes HTML through
verbatim. **Approach: preprocess to `markdown-it-container` blocks** (engine-independent
content; decided as D3).

The migration script converts:

```html
<div class="note" data-has-label="true" data-label="Video" markdown="1">
  * item …
</div>
```

into:

```markdown
::: note {"class":"note","data-has-label":"true","data-label":"Video"}

- item …
  :::
```

(The JSON blob after the container name carries **all** original attributes; omit it when
the only attribute is `class="<type>"`.)

**Converter algorithm** (`scripts/migrate-content.js`) — must be line-based and
stack-aware, not a single regex:

1. Scan lines; an opening tag with `markdown="1"` must be **alone on its line** (allow one
   trailing `{: #id}` IAL — fold it into the JSON attrs). Anything else → hard error with
   file:line.
2. Parse tag name + attributes; drop `markdown="1"`; **merge duplicate `class` attrs**
   (§2.1 quirk); primary container name = first class (`problem`, `solution`, `example`,
   `abstract`, `glossary`, `note`, `footnote-refs`), or `figure` for `<figure>` tags.
   Unknown class / tag → **hard error** (the census in §2.1 is the allow-list; the two
   `<section>`/`<parameter>` outliers are fixed by hand first).
3. Find the matching close tag by tracking depth across **all** open/close tags of the same
   name from that point (inner raw HTML like `<div class="title">…</div>` occurs inside and
   must not terminate the block early). Close tag must be alone on its line.
4. Nested `markdown="1"` blocks: none exist today (measured) — assert and hard-error if
   one appears.
5. Replace open line with `::: name {json}`, close line with `:::`. Assert the inner
   content contains no line starting with `:::`.

**Eleventy side** (`lib/eleventy/containers.js`): register one `markdown-it-container` per
name; the render function rebuilds the original element:

```js
export const CONTAINER_TYPES = [
  'abstract',
  'example',
  'problem',
  'solution',
  'note',
  'glossary',
  'footnote-refs',
  'figure',
  'exercise',
];

export function registerContainers(md, markdownItContainer) {
  for (const type of CONTAINER_TYPES) {
    md.use(markdownItContainer, type, {
      render(tokens, idx) {
        const tag = type === 'figure' ? 'figure' : 'div';
        if (tokens[idx].nesting === 1) {
          const info = tokens[idx].info.trim().slice(type.length).trim();
          const attrs = info ? JSON.parse(info) : { class: type };
          const html = Object.entries(attrs)
            .map(([k, v]) => `${k}="${md.utils.escapeHtml(String(v))}"`)
            .join(' ');
          return `<${tag} ${html}>\n`;
        }
        return `</${tag}>\n`;
      },
    });
  }
}
```

**Verify:** zero `markdown="1"` in built HTML; per-class element counts in the Eleventy
build equal the counts in the Jekyll baseline (P0.4 comparator checks this table).

### 4.4 Liquid-in-content & base path

With `markdownTemplateEngine: false` (D2) **no template engine touches markdown bodies**,
so math and `{{ … }}` can't collide. Then:

- **Strip** `{% raw %}` / `{% endraw %}` (58 pairs — they only existed to hide math from Liquid).
- **Rewrite** `{{ site.baseurl }}/x` → `/x` (34×) in content; root-relative URLs get the
  prefix at build time via the **`HtmlBasePlugin`** (bundled with Eleventy:
  `import { HtmlBasePlugin } from '@11ty/eleventy'`) + `pathPrefix: '/physics-book2/'`.
- Templates (`.njk`) use the `| url` filter (equivalent of Jekyll's `relative_url`).
- The `window.Book` inline script needs the prefix **without** a trailing slash: add a
  `trimSlash` filter (`v => v.replace(/\/+$/, '')`) and emit `{{ '/' | url | trimSlash }}`.

---

## 5. Phased plan

Phases in dependency order. Each lists **tasks → deliverables → acceptance**. Sizes:
S = under an hour, M = a work session, L = multiple sessions.

| Phase   | Goal                                                 | Size | Depends on |
| ------- | ---------------------------------------------------- | ---- | ---------- |
| **P0**  | Baseline freeze + parity comparator                  | M    | —          |
| **P1**  | Eleventy v4 installed, empty build runs              | S    | —          |
| **P2**  | Config, data, permalink contract                     | S    | P1         |
| **P3**  | Layouts/includes converted to Nunjucks               | M    | P1         |
| **P4**  | Markdown pipeline (the §4 problems) + fixture tests  | L    | P1         |
| **P5**  | Content migration script; 282 pages build            | L    | P4         |
| **P6**  | Assets/passthrough; site boots in browser            | S    | P2, P3     |
| **P7**  | Root pages: SUMMARY.html, index, sw.js, search       | M    | P5, P6     |
| **P8**  | Parity: comparator green, visual + QA scripts        | L    | P7         |
| **P9**  | CI/deploy rewritten (Node-only), PDF supply          | M    | P8         |
| **P10** | Cutover: converted content committed, Jekyll removed | M    | P9         |

### P0 — Baseline freeze & parity comparator

The single most valuable tool for this migration: a frozen Jekyll build to diff against.

1. **P0.1** Freeze the baseline: `bundle exec jekyll build -d _site_jekyll_baseline`
   (with baseurl as configured). Add `/_site_jekyll_baseline/` and `/src/contents/` to
   `.gitignore`.
2. **P0.2** Commit the content-pattern census (the §2.1 numbers) as
   `scripts/migration-census.json` by scripting the greps — the converter and comparator
   both read it (allow-list + expected counts).
3. **P0.3** Fix the two outliers by hand in `contents/` (the `<section data-depth="1"
markdown="1">` and `<parameter markdown="1">` occurrences — convert to plain HTML or a
   supported class) so the automated converter needs no special cases. Rebuild the baseline
   after (P0.1 again).
4. **P0.4** Write `scripts/compare-builds.js` (uses `cheerio`, already a dependency):
   for every page in both `_site_jekyll_baseline/` and `_site/` compare —
   - set of heading `id`s;
   - `img` count + each `src` + each `id`;
   - `a[href]` sets;
   - census of container classes (`div.problem`, `div.solution`, …);
   - all math spans: extract text nodes matching `$…$`/`$$…$$` and compare **verbatim**;
   - normalized text content (collapse whitespace; normalize `attr=""` vs bare attr —
     the v4 boolean-attribute change, §1.2).
     Output: per-page PASS/FAIL + summary table; `--page <slug>` for one-page detail.

**Acceptance:** baseline exists; comparator runs against baseline-vs-baseline with 100% PASS.

### P1 — Setup

1. **P1.1** `git checkout -b migrate/eleventy`.
2. **P1.2** Install deps (§1.3); pin the resolved Eleventy version.
3. **P1.3** Create `eleventy.config.js` (full file — this is the real one, not a sketch):

```js
import { HtmlBasePlugin } from '@11ty/eleventy';
import markdownIt from 'markdown-it';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItContainer from 'markdown-it-container';
import markdownItDeflist from 'markdown-it-deflist';
import markdownItFootnote from 'markdown-it-footnote';
import mathPassthrough from './lib/eleventy/markdown-it-math-passthrough.js';
import { kramdownSlugify } from './lib/eleventy/kramdown-slugify.js';
import { registerContainers } from './lib/eleventy/containers.js';

export default function (eleventyConfig) {
  const md = markdownIt({
    html: true, // raw HTML passes through (titles, inner divs)
    breaks: false,
    linkify: false, // Kramdown GFM does not autolink bare URLs — parity
    typographer: true, // Kramdown smart-quotes by default — parity (see D7)
  })
    .use(mathPassthrough) // MUST be first
    .use(markdownItDeflist)
    .use(markdownItFootnote)
    .use(markdownItAttrs, {
      leftDelimiter: '{:',
      rightDelimiter: '}',
      allowedAttributes: ['id', 'class', 'height', 'width', /^data-.*$/],
    })
    .use(markdownItAnchor, {
      slugify: kramdownSlugify,
      level: [1, 2, 3, 4, 5, 6],
    });
  registerContainers(md, markdownItContainer);
  eleventyConfig.setLibrary('md', md);

  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addFilter('trimSlash', v => String(v).replace(/\/+$/, ''));

  // Passthrough paths are relative to the project root (input is src/).
  eleventyConfig.addPassthroughCopy({
    assets: 'assets', // includes js/mathjax, pwa, pdf (when present)
    resources: 'resources',
    'summary.json': 'summary.json',
    'search_index.json': 'search_index.json', // committed copy for local dev; CI regenerates
  });

  return {
    dir: {
      input: 'src',
      includes: '_includes',
      layouts: '_includes/layouts',
      data: '_data',
    },
    templateFormats: ['md', 'njk', 'html'],
    markdownTemplateEngine: false, // D2: nothing touches markdown bodies
    htmlTemplateEngine: 'njk',
    pathPrefix: '/physics-book2/',
  };
}
```

4. **P1.4** `package.json` scripts (add alongside the Jekyll ones — they coexist until P10):

```json
"build:11ty": "eleventy",
"serve:11ty": "eleventy --serve --port=4000",
"migrate:content": "node scripts/migrate-content.js",
"compare:builds": "node scripts/compare-builds.js"
```

5. **P1.5** Keep Jekyll green: add to `_config.yml` `exclude:` — `src/`,
   `eleventy.config.js`, `lib/`, `_site_jekyll_baseline/`.

**Acceptance:** `mkdir -p src && npx eleventy` exits 0 (empty build); `npm run jekyll:build`
still works.

### P2 — Configuration & data

1. **P2.1** `src/_data/site.js` (replaces `_config.yml` site vars used in templates):

```js
export default {
  title: 'General Physics',
  tagline: 'An Open Textbook',
  description: 'This introductory, algebra-based, college physics book …', // copy from _config.yml
  author: 'Martin Veillette',
  url: 'https://veillette.github.io',
  repositoryUrl: 'https://github.com/veillette/physics-book2', // replaces site.github.repository_url
};
```

2. **P2.2** _(optional, not needed for parity)_ `src/_data/summary.js` reading root
   `summary.json`. **Note: `summary.json` is a top-level ARRAY** (`for chapter in summary`),
   not `{chapters: […]}`. The TOC is built client-side from `SUMMARY.html`, so no template
   consumes this today — skip unless adding server-side nav later.
3. **P2.3** Permalink contract (D5): `src/contents/contents.11tydata.js`:

```js
export default {
  layout: 'page',
  eleventyComputed: {
    // Jekyll parity: contents/x.md → /contents/x.html (Eleventy default would be x/index.html)
    permalink: data => `${data.page.filePathStem}.html`,
  },
};
```

Root pages get **static** front-matter permalinks (no template syntax needed):
`SUMMARY.md` → `permalink: /SUMMARY.html`; `sw.njk` → `permalink: /sw.js`.

**Acceptance:** a dummy `src/contents/test.md` builds to `_site/contents/test.html`; delete
the dummy after.

### P3 — Templates (Liquid → Nunjucks)

Jekyll's layouts are trivial; the work is `head.html` (~110 lines).

1. **P3.1** `src/_includes/layouts/default.njk`:

```njk
<!doctype html>
<html lang="en-us">
  {% include "head.njk" %}
  <body>
    {{ content | safe }} {% include "foot.njk" %}
  </body>
</html>
```

2. **P3.2** `src/_includes/layouts/page.njk`:

```njk
<!doctype html>
<html lang="en-us">
  {% include "head.njk" %}
  <body>
    <h1 class="page-title">{{ title }}</h1>
    {{ content | safe }} {% include "foot.njk" %}
  </body>
</html>
```

3. **P3.3** `src/_includes/head.njk` — copy `_includes/head.html` and apply exactly these
   substitutions (keep tag order identical — script order is load-bearing):

   | Jekyll (Liquid)                                   | Eleventy (Nunjucks)                            |
   | ------------------------------------------------- | ---------------------------------------------- |
   | `{{'/assets/css/theme.css'\| relative_url }}`     | `{{ '/assets/css/theme.css' \| url }}`         |
   | `{{ page.title }}`                                | `{{ title }}`                                  |
   | `{{ site.title }}` / `{{ site.tagline }}`         | same (from `_data/site.js`)                    |
   | `{{ site.github.repository_url }}`                | `{{ site.repositoryUrl }}`                     |
   | `rootUrl: '{{ site.baseurl }}'`                   | `rootUrl: '{{ "/" \| url \| trimSlash }}'`     |
   | `baseHref: '{{ site.baseurl }}'`                  | `baseHref: '{{ "/" \| url \| trimSlash }}'`    |
   | `toc: { url: '{{ site.baseurl }}/SUMMARY.html' }` | `toc: { url: '{{ "/SUMMARY.html" \| url }}' }` |

4. **P3.4** `src/_includes/foot.njk`: copy `foot.html`;
   `{{ site.baseurl }}/resources/by_license.svg` → `{{ '/resources/by_license.svg' | url }}`.
5. **P3.5** `src/index.njk`: copy `index.html` body verbatim (front matter
   `layout: default`, `title: Home`). The relative `assets/image/cover2.png` src is
   parity-correct as-is.

**Acceptance:** `npx eleventy` builds `_site/index.html`; open it — `<head>` matches the
Jekyll baseline's except for the known-cosmetic differences; `window.Book.rootUrl` has no
trailing slash.

### P4 — Markdown pipeline

1. **P4.1** Implement `lib/eleventy/markdown-it-math-passthrough.js` (§4.1, code given).
2. **P4.2** Implement `lib/eleventy/kramdown-slugify.js` (§4.2, code given).
3. **P4.3** Implement `lib/eleventy/containers.js` (§4.3, code given).
4. **P4.4** Write `tests/markdown-pipeline.test.js` (vitest) covering: all §4.1 math
   fixtures; IAL-on-image binding to `<img>`; IAL end-of-line binding to `<li>`; a
   `::: note {json}` container with data-attrs; a definition list; a footnote; a table
   containing math.

**Acceptance:** `npm run test:unit` green, including every fixture in §4.1.

### P5 — Content migration script

1. **P5.1** Write `scripts/migrate-content.js` implementing, **in this order per file**:
   1. parse front matter (gray-matter), pass through unchanged;
   2. strip `{% raw %}` / `{% endraw %}`;
   3. rewrite `{{ site.baseurl }}` → `` (leaving root-relative paths; HtmlBasePlugin
      prefixes them at build);
   4. convert `markdown="1"` blocks → containers (§4.3 algorithm; census-driven allow-list;
      hard errors on anything unexpected);
   5. fold next-line IALs (§4.2 rules: no-space after images, end-of-line for list items);
   6. assert output contains no `markdown="1"`, `{% raw`, `{: `-line-initial leftovers, or
      `{{ site.`;
   7. write to `src/contents/<same-name>.md` (and `src/SUMMARY.md` for the TOC page —
      injecting `permalink: /SUMMARY.html` into its front matter).
      Deterministic and idempotent: running twice yields identical output. `--check` mode
      exits non-zero if `src/contents/` is stale (used by CI later).
2. **P5.2** Run it: `npm run migrate:content` → 282 files + SUMMARY.md, zero errors.
3. **P5.3** `npx eleventy` → all pages build; grep gate on output:
   `grep -rl 'markdown="1"\|{:' _site/contents/ | wc -l` → **0**.

**Acceptance:** P5.2 + P5.3 pass; `npm run compare:builds` runs end-to-end (failures
expected at this stage — they drive P8).

### P6 — Assets & first boot

Passthrough was configured in P1.3; this phase verifies serving.

1. **P6.1** `npm run serve:11ty` (port 4000, path prefix served under `/physics-book2/`).
2. **P6.2** Boot check in a browser: navigation sidebar appears (TOC fetched — will 404
   until P7 emits SUMMARY.html; acceptable here), MathJax renders a chapter page, images
   load, CSS applies.

**Acceptance:** a `contents/` page renders with math and figures at
`http://localhost:4000/physics-book2/contents/ch1PhysicsAnIntroduction.html`.

### P7 — Root pages, service worker, search

1. **P7.1** `SUMMARY.md` — migrated by P5 (its leading list-item IALs `1. {: .chapter} […]`
   become trailing; verify `<li class="chapter">` in output — the client TOC parser and
   `scripts/parse-summary.js` both read this structure).
2. **P7.2** `src/sw.njk`: copy `sw.js` body; front matter
   `permalink: /sw.js`, `eleventyExcludeFromCollections: true`, `layout: null` dropped;
   replace `const BASE_URL = '{{ site.baseurl }}/';` → `const BASE_URL = '{{ "/" | url }}';`
   (the `${…}` template literals in the body don't collide with Nunjucks).
3. **P7.3** Search: `scripts/build-index.js` already reads `_site/**/*.html` and writes
   `_site/search_index.json` — run `npm run generate:search-index` against the Eleventy
   build and exercise the search UI.
4. **P7.4** PWA: offline flow against the dev server (`assets/pwa/offline.html` cached,
   service worker registers, `CORE_CACHE_FILES` all resolve — includes `/SUMMARY.html` and
   `search_index.json`).

**Acceptance:** TOC renders (SUMMARY.html present), prev/next links work (client-built),
search returns results, `sw.js` served at site root with correct BASE_URL, offline page
loads with the network disabled.

### P8 — Parity validation

1. **P8.1** Drive `npm run compare:builds` to green, page by page. Expected legitimate
   diff classes to whitelist in the comparator (document each): boolean-attr formatting
   (v4), insignificant whitespace, `<em>`-entity encodings. Everything else gets fixed in
   the pipeline (P4) or converter (P5), **not** by hand-editing generated files.
2. **P8.2** Run the QA suite against the Eleventy build:
   `check:links`, `check:orphans`, `check:figures`, `check:cross-refs`, `check:math`,
   `find:latex`, `crawl` (all already point at `_site` / port 4000).
3. **P8.3** Visual regression: Playwright screenshot diff, Jekyll baseline vs Eleventy, on
   a stratified sample (per chapter: 1 intro page, 1 heavy-math section, 1
   problems/solutions page, SUMMARY, index) — after MathJax settles
   (`MathJax.startup.promise`).
4. **P8.4** Manual spot-checks: figure captions containing math (`book-viewer.js` rewrites
   backslashes in `title` attrs at runtime — confirm captions like `\theta_r = \theta_i`
   render; markdown-it un-doubles `\\` in image titles at build time, which the runtime
   handles, but verify on real pages, e.g. the mirror/refraction figures).

**Acceptance:** comparator 100% PASS (with documented whitelist), QA suite green, visual
diffs signed off.

### P9 — CI & deploy (Node-only)

1. **P9.1** Rewrite `.github/workflows/deploy.yml`: drop `ruby/setup-ruby` + Jekyll; build =

```yaml
- uses: actions/setup-node@v6
  with: { node-version: '24', cache: 'npm' }
- run: npm ci
- uses: actions/configure-pages@v6
  id: pages
- run: npm run migrate:content # remove this line after P10 cutover
- run: npx @11ty/eleventy --pathprefix "${{ steps.pages.outputs.base_path }}"
- run: npm run generate:search-index
- uses: actions/upload-pages-artifact@v5
```

2. **P9.2** PDF supply (see D6): add a deploy step that restores `assets/pdf/` **before**
   the Eleventy build (the `assets` passthrough then ships them) — download from the
   `generate-pdfs` workflow artifact or a GitHub Release asset. If absent, deploy proceeds
   without PDFs (buttons 404) — log a warning, don't fail.
3. **P9.3** `ci.yml`: bump `node-version` to `"24"` (×3); add jobs:
   `npm run migrate:content -- --check` (until P10), `npx eleventy`, grep gates
   (no `{:`/`markdown="1"`/`{% raw` in `_site`), `npm run compare:builds` (until P10),
   `npm run test:unit`.
4. **P9.4** Bump `node-version` in `link-check.yml` (×2) and `generate-pdfs.yml`; point the
   PDF workflow's build step at Eleventy instead of Jekyll.
5. **P9.5** `vercel.json` (currently runs Jekyll): `buildCommand` →
   `"npm run migrate:content && npx @11ty/eleventy --pathprefix=/"`, `installCommand` →
   `"npm ci"` (drop `gem install bundler`). Optional — Vercel project is legacy
   (`physics-book.vercel.app`); update or delete, but don't leave it silently broken.

**Acceptance:** deploy workflow green on the branch (use `workflow_dispatch` against a
preview), Pages serves the Eleventy site at `/physics-book2/`, search index regenerated in
CI, PDFs present (or warning logged).

### P10 — Cutover

One PR, reviewed as a whole:

1. Run `npm run migrate:content` one final time; **commit the converted files into root
   `contents/`** (replacing the Kramdown sources) and root `SUMMARY.md`.
2. Move the Eleventy tree to its final home: `src/_includes/*` → `_includes/` (deleting
   `head.html`/`foot.html`), `src/_data` → `_data/`, `src/index.njk` → `index.njk` (delete
   `index.html`), `src/sw.njk` → `sw.njk` (delete `sw.js`); delete `src/`.
3. `eleventy.config.js`: `dir.input: '.'`; add `.eleventyignore` — `README.md`,
   `CONTRIBUTE.md`, `CHANGELOG.md`, `claude.md`, `roadmap.md`, `LICENSE.txt`, `doc/`,
   `scripts/`, `tests/`, `hooks/`, `resources/` (images only — passthrough covers it),
   `_site_jekyll_baseline/`.
4. Delete Jekyll: `Gemfile`, `Gemfile.lock`, `_config.yml`, `_layouts/`; remove `jekyll:*`
   npm scripts; flip `"build": "eleventy"`, `"serve": "eleventy --serve --port=4000"`;
   retire `scripts/migrate-content.js` (and its CI steps) — it has no inputs anymore.
5. Update the two Kramdown-coupled scripts (**only these reference `{:` in `scripts/`**):
   `scripts/parse-summary.js` (reads SUMMARY.md's IALs — now trailing) and
   `scripts/check-cross-references.js`; update `tests/parse-summary.test.js` fixtures.
   Sweep the remaining QA scripts once against the converted source (`npm run check:all`)
   and fix any that assumed Kramdown syntax in **source** files.
6. Update docs: `README.md`, `CONTRIBUTE.md`, `claude.md` (build instructions →
   `npm run build` / `npm run serve`, Node ≥22.15, no Ruby), `CHANGELOG.md` entry.
7. Full re-validation: P8.1–P8.3 one last time against the final tree, then merge to
   `main`; confirm the Pages deploy.
8. Post-merge: delete `_site_jekyll_baseline/` locally; keep the P0 census + comparator
   (useful for future engine upgrades).

**Acceptance:** the Definition of Done (§9), on `main`, deployed.

---

## 6. Decisions

| #      | Decision                             | Choice (rationale)                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | Layout template engine               | **Nunjucks** (`.njk`) for layouts/includes.                                                                                                                                                                                                                                                                                    |
| **D2** | Template engine over markdown bodies | **None** (`markdownTemplateEngine: false`) — protects math; Liquid remnants removed at migration (§4.4).                                                                                                                                                                                                                       |
| **D3** | `markdown="1"` handling              | **Preprocess to fenced containers** — engine-independent content, testable converter (§4.3).                                                                                                                                                                                                                                   |
| **D4** | Directory layout                     | **`src/` staging during migration; content returns to root at cutover.** `src/contents/` is a _gitignored build artifact_ until P10, so canonical content stays Kramdown (upstream fixes merge cleanly) and both builds stay green on every branch commit. Final root layout keeps the ~40 scripts' `contents/` paths working. |
| **D5** | URLs/permalinks                      | **Byte-identical to Jekyll**: `contents/x.md → /contents/x.html`, `/SUMMARY.html`, `/sw.js`, `/index.html`. Hard requirement.                                                                                                                                                                                                  |
| **D6** | PDF supply at deploy                 | **Restore `assets/pdf/` from the `generate-pdfs` workflow artifact (or a GitHub Release asset) before the build**; regenerating 282 PDFs inside every deploy is too slow. Missing PDFs warn, never fail the deploy.                                                                                                            |
| **D7** | Smart typography                     | **`typographer: true`** — Kramdown smart-quotes by default, so this is the parity choice. If the P8 diff shows quote-rule mismatches, prefer adjusting `quotes:` options over disabling (disabling would visibly change every page).                                                                                           |
| **D8** | Autolinking                          | **`linkify: false`** — Kramdown GFM does not autolink bare URLs; enabling would create new links Jekyll never had.                                                                                                                                                                                                             |

---

## 7. Tooling & script impact matrix

| Scripts                                                                                                                                                         | Impact                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Source-reading QA (`check:math`, `check:figures`, `check:yaml`, `lint:markdown`, `fix:*`, …)                                                                    | None until P10; after cutover they read the converted markdown — sweep once (P10.5)                   |
| `scripts/parse-summary.js`, `scripts/check-cross-references.js`                                                                                                 | **Only scripts containing `{:` logic** — update at P10.5 (+ `tests/parse-summary.test.js`)            |
| `_site`-reading (`build-index.js`, `check-orphans`, `validate-deploy`)                                                                                          | Work unchanged — Eleventy also outputs to `_site`; baseline lives in `_site_jekyll_baseline`          |
| `localhost:4000` scripts (`generate-pdf*.js`, `crawl-all-pages`, `check-*-page`, `check-all-math-rendering`, `find-unrendered-latex`, `regenerate-failed-pdfs`) | Work unchanged — dev server pinned to port 4000 (`serve:11ty`)                                        |
| `sync-config.js`                                                                                                                                                | Reads `_config.yml` — retarget to `_data/site.js` or retire at P10                                    |
| vitest suite                                                                                                                                                    | Grows: `markdown-pipeline.test.js` (P4.4); `parse-summary` fixtures updated at P10                    |
| Workflows                                                                                                                                                       | All get `node-version: "24"`; `deploy.yml` rewritten (P9.1); `generate-pdfs.yml` builds with Eleventy |

---

## 8. Risks & rollback

| Risk                                                                 | Mitigation                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Eleventy v4 alpha bug blocks progress**                            | Config restricted to v3-stable APIs → fall back to `@11ty/eleventy@^3.1.6` with zero config changes (§1.1)    |
| markdown-it output differs subtly from Kramdown (entities, wrapping) | P0.4 comparator on **every** page + whitelist of documented cosmetic diffs; Playwright visual sample (P8.3)   |
| Math mangled (backslashes, emphasis, `&`)                            | §4.1 passthrough plugin + fixture tests + `find:latex`/`check:math` on output + math-verbatim comparator rule |
| A `{: …}` / `markdown="1"` edge case renders as literal text         | Converter hard-errors on unknown patterns (census allow-list); CI grep gate on `_site` (P9.3)                 |
| Heading ids drift (Kramdown vs slugifier) breaking anchors           | `kramdownSlugify` + comparator diffs every heading id + `check:cross-refs`                                    |
| Upstream content changes during the long migration                   | D4: canonical source stays Kramdown; converter re-runs deterministically until cutover day                    |
| Regression discovered post-cutover                                   | Whole conversion on `migrate/eleventy`; `main` stays Jekyll until sign-off — revert = revert one merge        |

---

## 9. Definition of done

- [ ] `npx eleventy` builds all 282 content pages + SUMMARY + index + sw.js with **zero**
      leftover `{:`, `markdown="1"`, `{% raw %}`, or `{{ site.` in `_site` (CI-gated).
- [ ] Every output path byte-matches the Jekyll mapping (D5): `contents/<slug>.html`,
      `/SUMMARY.html`, `/sw.js`, `/index.html`.
- [ ] `compare-builds.js` 100% PASS against the frozen Jekyll baseline (whitelist documented).
- [ ] Math verbatim-identical (comparator rule) and MathJax renders on the visual sample.
- [ ] TOC, prev/next, search, and the PWA offline flow work against `_site`.
- [ ] `check:links`, `check:cross-refs`, `check:orphans`, `check:figures`, `check:math`,
      `test:unit` all green on the converted tree.
- [ ] GitHub Pages deploys from the Node-only workflow (Node 24); search index regenerated
      in CI; PDF supply wired (D6).
- [ ] `Gemfile`, `Gemfile.lock`, `_config.yml`, `_layouts/`, old `_includes/*.html`,
      `index.html`, `sw.js`, `src/` removed; `parse-summary`/`check-cross-references` +
      tests updated; README/CONTRIBUTE/claude.md updated.

---

## 10. Known errors in the superseded draft

`doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md` predates the measurements; where it conflicts
with this roadmap, **this roadmap wins**. Specifically, that draft:

- iterates `summary.chapters` — `summary.json` is a **top-level array**;
- uses `pathPrefix: '/physics-book/'` — must be `/physics-book2/`;
- sets `markdownTemplateEngine: 'njk'` — conflicts with math; use `false` (D2);
- converts `$$…$$` → `\(…\)` — wrong and unnecessary; delimiters must be preserved
  verbatim (§4.1); its `&amp;→&` transform is likewise wrong (would corrupt non-math HTML);
- adds `markdown-it-implicit-figures` — would double-wrap figures built by
  `book-viewer.js` at runtime (§2.3);
- proposes server-side navigation includes/collections — the nav is client-rendered;
  out of scope for parity;
- targets Eleventy 3.x / Node 20 — this plan targets v4 / Node ≥22.15.

## 10a. P0–P4 execution findings (2026-07-06) — corrections to THIS roadmap

P0–P4 are implemented on `migrate/eleventy`. Building real pages and diffing against the
frozen Jekyll baseline (P4.5) proved several assumptions in §2 and §4 wrong. Where this
section conflicts with §4, **this section wins** — it is verified against kramdown 2.5.1
source (in `vendor/bundle`) and against byte-parity on `ch10DynamicsOfRotationalMotion` and
`ch19EnergyStoredInCapacitors`.

- **Math is NOT verbatim passthrough (§4.1 was wrong).** With `math_engine: null` Kramdown
  wraps math: inline `$$…$$` → `<span class="kdmath">$…$</span>` (single `$`, content
  `.strip`ped) so MathJax renders it _inline_; a standalone block `$$…$$` →
  `<div class="kdmath">$$\n…\n$$</div>`. Content is emitted **raw/unescaped** (the baseline
  really contains raw `&` and `<` inside kdmath). Only `$$…$$` is math — single `$`, `\(`,
  `\[` are **not** (Kramdown's escape set `[\\.*_+``<>()\[\]{}#!:|"'$=-]` collapses `\(`→`(`,
  matching markdown-it's escape rule). `$$…$$` inside raw HTML (e.g. `<div class="equation">`)
  stays verbatim because markdown-it's `html_block` claims it first. Implemented in
  `lib/eleventy/markdown-it-kramdown-math.js` (replaces the deleted `…math-passthrough.js`);
  the P0.4 comparator's math rule and the fixture tests assert this.
- **Typography: drop markdown-it `replacements` (D7 refinement).** `typographer: true`
  also does `(c)`→©, `(tm)`→™, `+-`→± which Kramdown never does (baseline: 0 `©`, 1549
  literal `(c)`). Kramdown only substitutes `--- -- ... << >>`. `lib/eleventy/markdown-it-
kramdown-typography.js` disables `replacements`, keeps `smartquotes`, and re-adds only
  Kramdown's symbols.
- **Kramdown slug (§4.2 snippet was wrong):** `basic_generate_id` strips leading non-letters
  **first**, then substitutes **each** space with a dash (`tr`, not a collapsing `gsub`), so
  `Problems & Exercises` → `problems--exercises` (double dash). Fixed in `kramdown-slugify.js`.
- **markdown-it-anchor needs `tabIndex: false`** (Kramdown emits `id=` only, no `tabindex`).
- **Image IALs must be LEFT UNFOLDED (§4.2 folding rule was wrong).** Kramdown binds the
  next-line `{: #FigureN}` to the enclosing `<p>` (`<p id="Figure1"><img></p>`), and
  markdown-it-attrs does the same when the IAL stays on its own line. Folding it onto the
  `<img>` diverges from the baseline. (The runtime figure builder reads `img.getAttribute
('id')`, so it currently gets null on figures — that is existing baseline behaviour we
  preserve, not something to "fix" during the migration.)
- **P5 converter — raw wrappers need blank lines.** A raw `<div class="exercise">` (no
  `markdown="1"`) that wraps `::: problem`/`::: solution` containers must get a blank line
  after the opening tag and before the closing `</div>`, or markdown-it's `html_block` rule
  swallows the `:::` fences and renders them literally. Raw text wrappers (`<div class=
"title">`, `<div class="equation">`) must instead stay contiguous (no inner blanks) but be
  separated from following markdown by a blank line.
- **Eleventy vs .gitignore:** `src/contents/` is gitignored (build artifact) but Eleventy
  honours `.gitignore` for input, so it silently skipped every content page. Fixed with
  `setUseGitIgnore(false)` + a `.eleventyignore`; `.gitignore` narrowed to
  `/src/contents/*.md` so `contents.11tydata.js` stays tracked.
- **HtmlBasePlugin vs `| url`:** using both double-prefixes URLs
  (`/physics-book2/physics-book2/…`). Templates use PLAIN root-relative asset URLs (let
  HtmlBasePlugin add the prefix); `| url` is kept only for the `window.Book` script-body
  values, which HtmlBasePlugin does not touch (§3, P3.2).
- **Three more `markdown="1"` outliers than §2.1 listed**, all fixed in P0.3 and captured by
  `scripts/generate-census.js` → `migration-census.json`: `ch31` `class="Example1"` (mis-cased,
  → `example`), plus a commented-out `<figure markdown="1">` in `ch28` (correctly ignored).
  Real `markdown="1"` block count is **6938**; container allow-list is the 8 names in the
  census JSON.

## 10b. P5–P9 execution findings (2026-07-07)

P5, P6, P7 and P9 are implemented on `migrate/eleventy`; P8 is well underway. The site
builds, boots, and is deployable from the branch in its **staging** shape (Kramdown source

- `scripts/migrate-content.js` → `src/` → Eleventy). P10 (the irreversible cutover that
  deletes the Kramdown source and merges to `main`) is intentionally **not executed** — see
  the note at the end.

**P5 — converter (`scripts/migrate-content.js`), corrections to §4/§10a:**

- **Duplicate `class` attrs → LAST value wins, not merged** (§2.1's "merge" was wrong):
  `class="note" … class="interactive"` renders `class="interactive"`. Added an
  `interactive` container (`containers.js` + census); the census generator now uses the
  last class attribute too.
- **Container fences need depth-aware colon counts.** `<figure markdown="1">` nests inside
  `note`/`example` (§4.3's "no nested markdown=1" was wrong). markdown-it-container matches
  a close by marker length and does not track nesting, so each container gets
  `3 + (maxDepth − depth)` colons (outer > inner).
- **Raw wrappers:** blank line only AFTER a raw-close (never before a raw-open — that breaks
  an indented `<div class="equation">` continuing a list item); raw-wrapper body re-indented
  to the wrapper's column so an un-indented `$$…$$` stays inside its html_block; blank lines
  inside raw `<table>` stripped so cell `$$…$$` stays verbatim.
- **Mid-line block tags escaped.** A `<div class="equation">` in the middle of a paragraph
  is span-context for Kramdown, which escapes it to text; the converter escapes mid-line
  `<div|figure|section>` so markdown-it doesn't emit a real, unbalanced element.
- **IAL handling:** a standalone IAL (blank line before) binds FORWARD to the next heading
  in Kramdown (e.g. `{: #Table1}` after a table → the following `### Efficiency`); list-item
  IAL folding is item-aware (moves to the end of the item's own content, not past a nested
  list); wrapped/emphasis-adjacent IALs are joined (footnote-refs, `**term**`/`{: …}`).

**Pipeline (`lib/eleventy/`):**

- **Math block-vs-span** is decided in a post-inline core rule: a `$$…$$` that is the sole
  content of a paragraph or list item becomes a display `<div class="kdmath">`, otherwise an
  inline `<span class="kdmath">`. This is robust where a block-ruler heuristic is not
  (markdown-it gives no tight per-list-item line range).
- **`markdown-it-raw-titles`** keeps link/image `title` backslashes verbatim (`\( 2T \)`)
  but decodes HTML entities (`&#x2019;` → `’`) so captions match after entity normalisation.
- **Typography**: added Kramdown's `<<`→«, `>>`→» (D7).
- **`HtmlBasePlugin` replaced** by a narrow `href|src="/…"` prefix transform: it leaves
  `./ ../ # http(s)` verbatim (HtmlBasePlugin normalised `./x`→`x`, breaking 54 pages) and
  reads the active `pathPrefix`, so `VERCEL=1` builds at root while Pages builds under
  `/physics-book2/`.

**P6/P7 — boot verified** on the dev server (port 4000): MathJax renders, the client figure
builder wraps `img[title]` into `figure`+`figcaption`, the TOC loads from `/SUMMARY.html`,
`window.Book.rootUrl` has no trailing slash, `sw.js` is emitted with the right `BASE_URL`,
and the search index loads. (`src/sw.njk` → `/sw.js`.)

**P9 — Node-only CI/deploy.** `deploy.yml`/`ci.yml`/`generate-pdfs.yml`/`link-check.yml`
drop Ruby, use Node 24, and build with Eleventy. PDFs (D6) are published to a `pdfs` GitHub
Release by `generate-pdfs.yml` and restored by `deploy.yml` (warn if absent). CI grep gates
(no `markdown="1"`/line-initial `{:`/`:::`/`{% raw` in `_site`) are **green**. `vercel.json`
uses `npm ci` + Eleventy. (Note: `npm run test:unit` still fails the 21 **pre-existing**
QA-script tests — `check-links.getLineNumber`, `check-math` currency, `check-orphans` — which
are P10.5 sweep items, unrelated to the migration; `markdown-pipeline.test.js` is green.)

**P8 — parity status:** `compare-builds.js` self-test is 285/285; the Eleventy build is
**183/285** shared pages PASS (all container-census and nearly all heading-id/link facets
clean). The ~102 remaining are, in decreasing order, `text`/`math`/`images`/`links` diffs
concentrated in malformed-source constructs and genuine Kramdown-vs-CommonMark differences:

- **Cosmetic / MathJax-equivalent** (whitelist candidates): display-math internal whitespace;
  smartquote _direction_ on `="` inside inert leaked text (`{ type="a"}`, `**{: class="term"}`)
  which is present in the baseline too.
- **Malformed source** (Kramdown is lenient, CommonMark is not): mid-line `<div class="equation">`
  runs (~9 pages), nested double-quotes inside an image `title` that spill a real `<a>`
  (spurious links), `** $$x$$ **` emphasis with an interior space.
- **Complex hand-written HTML tables / GFM tables** (appendixA, Glossary).

**P10 — NOT executed (deliberate).** The cutover deletes the canonical Kramdown source and
retires the converter (making it un-rerunnable), then merges to `main`; the roadmap gates
this on P8 parity sign-off and keeps `main` on Jekyll until then. At 183/285 that sign-off
is not met, so the destructive steps and the merge are left for a human decision. Everything
up to the cutover is committed and re-runnable; the branch deploys correctly in the staging
shape via the P9 workflow.

## 11. References

- [Eleventy docs](https://www.11ty.dev/docs/) · [v4 release notes](https://github.com/11ty/eleventy/releases)
- [markdown-it](https://github.com/markdown-it/markdown-it) · [markdown-it-attrs](https://github.com/arve0/markdown-it-attrs) · [markdown-it-container](https://github.com/markdown-it/markdown-it-container) · [markdown-it-deflist](https://github.com/markdown-it/markdown-it-deflist)
- [HtmlBasePlugin](https://www.11ty.dev/docs/plugins/html-base/) · [Permalinks](https://www.11ty.dev/docs/permalinks/) · [Passthrough copy](https://www.11ty.dev/docs/copy/)
- `doc/KRAMDOWN_MIGRATION_REVIEW.md` — Kramdown syntax deep dive
- `doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md` — the MyST alternative (not chosen)
