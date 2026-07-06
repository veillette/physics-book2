# Roadmap: Migrating `physics-book2` from Jekyll to Eleventy

This document describes **how we convert this textbook site from Jekyll (Ruby/Kramdown)
to Eleventy (Node/markdown-it)** — the motivation, the concrete work, the order to do it
in, the decisions that need to be made, and how to verify we didn't break anything.

It is the high-level orchestration plan. The **line-by-line code** for each step (config
files, migration scripts, template conversions) already lives in
[`doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md`](doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md);
this roadmap ties those pieces together and reflects the **actual, measured** state of the
repository. See also [`doc/KRAMDOWN_MIGRATION_REVIEW.md`](doc/KRAMDOWN_MIGRATION_REVIEW.md)
and the alternative [`doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md`](doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md).

---

## 0. Status & what has already been done

This repository is a **deep copy** of [`veillette/physics-book`](https://github.com/veillette/physics-book).
As the first step of this migration it has been re-homed to its own repo so the conversion
can proceed without touching the original.

Completed in the setup phase:

- [x] Pulled the latest `main` from the source repo.
- [x] Created a new GitHub repository: **`veillette/physics-book2`** (public).
- [x] Rewired git remotes:
  - `origin` → `git@github.com:veillette/physics-book2.git` (this project going forward)
  - `upstream` → `git@github.com:veillette/physics-book.git` (original, for pulling updates)
- [x] Updated internal references from `physics-book` → `physics-book2`:
  - `_config.yml` — `baseurl: /physics-book2`, `repository: veillette/physics-book2`
  - `package.json` — `name`, `repository`
  - Hardcoded runtime base paths — `assets/js/search.js`, `assets/pwa/offline.html`,
    `scripts/build-index.js`, `sw.js` (cache namespace), `scripts/check-orphans.js`
    (base-path strip) + its test
  - Local-dev / tooling URLs in `scripts/*` and `.github/workflows/generate-pdfs.yml`
  - Docs: `README.md`, `claude.md`, `CONTRIBUTE.md`, `hooks/README.md`
  - Regenerated `search_index.json` links to `/physics-book2/`
  - _Left intentionally unchanged:_ the Vercel URLs (`physics-book.vercel.app` — no
    `physics-book2` Vercel project exists yet) and a `/home/user/...` placeholder path.
- [x] **Started a fresh single-commit history.** The source repo's `.git` was 3.3 GB
      (1,766 commits, ~8,300 committed PDF blobs), which exceeds GitHub's 2 GiB push limit.
      `physics-book2` begins as a clean snapshot; the full commit history remains available
      on the `upstream` remote.
- [x] **Stopped tracking generated PDFs.** `assets/pdf/` is now in `.gitignore` — these are
      build artifacts (produced by `scripts/generate-pdf.js` and the `generate-pdfs`
      workflow), so keeping them out of git prevents the repo from re-bloating.

> **Note:** These setup steps kept the site on **Jekyll**. Everything below is the actual
> framework conversion, which has **not** started yet.
>
> **PDF hosting follow-up:** because PDFs are no longer committed, the deploy pipeline must
> supply them at build time — either regenerate during deploy, publish them as GitHub
> Release assets, or restore `assets/pdf/` from the `generate-pdfs` job output. Wire this up
> as part of Phase 9 (Build & Deploy).

---

## 1. Why Eleventy

| Concern         | Jekyll (today)                      | Eleventy (target)                              |
| --------------- | ----------------------------------- | ---------------------------------------------- |
| Runtime         | Ruby + Bundler                      | Node.js (already required for all our tooling) |
| Toolchain split | Ruby build **and** ~40 Node scripts | One Node toolchain                             |
| Markdown        | Kramdown (GFM)                      | markdown-it (+ plugins)                        |
| Build speed     | Slower on 282 pages                 | Faster incremental builds                      |
| CI setup        | Sets up **both** Ruby and Node      | Node only                                      |

The win is **one language for the whole project.** We already lint, check, generate PDFs,
build the search index, and test with Node; only the site _build_ is Ruby. Eleventy removes
that split.

---

## 2. Current architecture (measured)

```
physics-book2/
├── _config.yml              # Jekyll config → replace with eleventy.config.js
├── Gemfile / Gemfile.lock   # Ruby deps → remove at cutover
├── _layouts/                # default.html, page.html (Liquid)
├── _includes/               # head.html, foot.html (Liquid partials)
├── index.html               # home page (layout: default)
├── contents/                # 282 chapter/section markdown files
├── assets/                  # css, js (incl. bundled mathjax), icon, image, manifest, pdf, pwa
├── resources/               # 1,358 figure/image assets
├── summary.json             # navigation data (array of chapters → sections)
├── SUMMARY.md               # human-readable TOC
├── sw.js                    # service worker (Jekyll-templated)
├── scripts/                 # ~40 Node maintenance/QA scripts
└── tests/                   # vitest unit tests
```

**Content facts that drive the migration difficulty** (counted, not estimated):

| Pattern                                      |      Count | Files | Why it matters                                                              |
| -------------------------------------------- | ---------: | ----: | --------------------------------------------------------------------------- |
| Kramdown attributes `{: #id}` / `{: .class}` |      1,774 |   279 | Non-standard markdown; needs `markdown-it-attrs` with a `{:` delimiter      |
| `markdown="1"` HTML blocks                   |      6,940 |   269 | Kramdown parses markdown _inside_ HTML; markdown-it does **not** by default |
| `{% raw %}…{% endraw %}`                     | 58 (pairs) |    13 | Liquid escaping around math; must be removed for Eleventy                   |
| `{{ site.baseurl }}` in content              |         34 |     — | Liquid variable in markdown body; needs a base-path mechanism               |
| MathJax `$$…$$`                              |  pervasive |  most | Must survive markdown processing untouched                                  |

Front matter is uniform and simple: `title`, `layout`, `sectionNumber`, `chapterNumber`.

Rendering is **client-side**: `assets/js/book-viewer.js` builds the reading UI, `search.js`
with `minisearch` powers search, and MathJax renders math in the browser. This JavaScript is
framework-agnostic and carries over essentially unchanged.

---

## 3. Target architecture

```
physics-book2/
├── eleventy.config.js       # markdown-it config, passthrough, collections, filters
├── package.json             # + @11ty/eleventy, markdown-it, plugins
├── src/                     # (or keep root — see Decision D4)
│   ├── _data/site.js        # replaces _config.yml site.* variables
│   ├── _data/summary.js     # navigation (from existing summary.json)
│   ├── _includes/           # head.njk, foot.njk + layouts/{default,page}.njk
│   ├── contents/            # migrated markdown
│   ├── assets/ resources/   # passthrough-copied
│   └── index.njk
└── _site/                   # build output (was Jekyll's default _site)
```

---

## 4. The three hard problems (and how we solve them)

Everything else is mechanical. These three are where the real work is.

### 4.1 Kramdown attribute lists `{: #id .class}` (1,774 occurrences)

- **Solution:** `markdown-it-attrs`, configured with `leftDelimiter: '{:'`,
  `rightDelimiter: '}'`, and an allow-list (`id`, `class`, `height`, `width`, `data-*`).
- **Watch out:** Kramdown allows the attribute block on the _next line_ (block-level
  application to the preceding element); markdown-it-attrs expects it inline. A
  preprocessing pass folds a trailing `{: … }` line up onto the element it decorates.
- **Verify:** zero `{:` survive into rendered HTML.

### 4.2 `markdown="1"` blocks (6,940 occurrences)

Kramdown re-parses markdown inside `<div class="…" markdown="1">…</div>`. markdown-it with
`html: true` passes HTML through **verbatim** — it will _not_ parse the markdown inside.
Two viable approaches:

- **A (recommended): preprocess to fenced containers.** Convert
  `<div class="abstract" markdown="1"> … </div>` → a `markdown-it-container` block
  (`::: abstract … :::`) that renders to the same `<div class="abstract">`. The inner
  markdown is then parsed normally. Container types in use: `abstract`, `equation`,
  `example`, `note`, `exercise`, plus the glossary structures.
- **B: custom core rule** that finds `markdown="1"` blocks and renders their inner content
  through `md.render()`. Keeps content files untouched but is more brittle.

Approach A produces cleaner, engine-independent content and is the target.

### 4.3 Base-path & math coexistence

- `{{ site.baseurl }}` (34×) and `{% raw %}` (58×) are **Liquid** — if Eleventy runs a
  template engine over markdown, it will fight with `$$…$$` math.
- **Solution / Decision D2:** set `markdownTemplateEngine: false` so **no** template engine
  touches content bodies. Then:
  - Strip `{% raw %}` / `{% endraw %}` wrappers (they only existed to hide math from Liquid).
  - Rewrite `{{ site.baseurl }}` → the correct prefix during the content-migration pass
    (or replace with root-relative links and let Eleventy's `pathPrefix` handle it).
  - Math passes through markdown-it untouched (MathJax renders it client-side, as today).

---

## 5. Phased plan

Strategy: **parallel build.** Keep Jekyll fully working; build Eleventy alongside it; only
delete `Gemfile`/`_config.yml`/`_layouts` at the final cutover (Phase 9). Do the whole thing
on a `migrate/eleventy` branch.

| Phase                      | Goal                                 | Key outputs                                                           | Depends on |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------- | ---------- |
| **P1 Setup**               | Eleventy installed, empty build runs | `eleventy.config.js`, deps in `package.json`                          | —          |
| **P2 Config**              | `_config.yml` → data files           | `_data/site.js`, `_data/summary.js`                                   | P1         |
| **P3 Templates**           | Liquid → Nunjucks                    | `head.njk`, `foot.njk`, `default.njk`, `page.njk`, `index.njk`        | P1         |
| **P4 Markdown pipeline**   | markdown-it matches Kramdown output  | attrs + container + anchor + figures config; the 3 hard problems (§4) | P1         |
| **P5 Content**             | 282 files build correctly            | `scripts/migrate-content.js`, migrated `contents/`                    | P4         |
| **P6 Assets**              | CSS/JS/images/PDF/PWA served         | passthrough copies incl. `resources/` (1,358)                         | P1         |
| **P7 Nav & data**          | TOC + prev/next work                 | navigation include, collections                                       | P2, P5     |
| **P8 PWA**                 | offline + service worker             | `sw.js` path/cache updates, `manifest`                                | P6         |
| **P9 Build & deploy**      | Pages deploys from Eleventy          | rewritten `.github/workflows/deploy.yml` + `ci.yml`; remove Ruby      | P1–P8      |
| **P10 Validate & cutover** | Parity proven, Jekyll removed        | validation scripts, visual diffs, delete `Gemfile`/`_layouts`         | P9         |

Detailed, copy-pasteable code for each phase is in
[`doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md`](doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md)
(Phases 1–10 map 1:1 to that document). **Corrections to apply from that doc** given what we
measured:

- `summary.json` is a **top-level array**, not `{ "chapters": [...] }`. Iterate it directly
  (`for chapter in summary`), not `summary.chapters`.
- Use `pathPrefix: '/physics-book2/'` (not `/physics-book/`).
- Prefer `markdownTemplateEngine: false` for content (§4.3) over Nunjucks-on-markdown, to
  avoid math/template conflicts.

---

## 6. Decisions to make before P4

| #      | Decision                                 | Options                                 | Recommendation                                                        |
| ------ | ---------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| **D1** | Template engine for layouts              | Nunjucks vs Liquid                      | **Nunjucks** for layouts/includes (matches the existing doc/plan).    |
| **D2** | Template engine over **markdown bodies** | Nunjucks / Liquid / **none**            | **None** (`markdownTemplateEngine: false`) — protects math, see §4.3. |
| **D3** | `markdown="1"` handling                  | preprocess to containers vs custom rule | **Preprocess to containers** (§4.2, approach A).                      |
| **D4** | Directory layout                         | `src/` tree vs build from repo root     | **`src/`** — clean separation from Jekyll during the parallel phase.  |
| **D5** | URL/permalinks                           | keep `contents/<name>.html`             | **Keep exactly** — preserves every existing inbound/anchor link.      |

D5 is a hard requirement: output paths **must** stay `contents/<slug>.html` so bookmarks,
cross-references, the search index, and PDFs keep working.

---

## 7. Tooling & tests impact

- Most `scripts/*` (the `check:*` / `fix:*` / `lint:*` linters) read **markdown source** and
  are framework-agnostic — they keep working unchanged.
- Scripts that assume Jekyll's `_site` or `localhost:4000` (`build-index.js`,
  `generate-pdf*.js`, `crawl-all-pages.js`, `validate-deploy.js`) need their base URL / build
  step pointed at the Eleventy dev server and `_site` output. Base paths were already updated
  to `/physics-book2` in the setup phase.
- `search_index.json` is generated from the built site — regenerate it via CI after the
  Eleventy build (the deploy workflow already runs `generate:search-index`).
- `vitest` unit tests: re-run; the only fixture touched so far is the orphan base-path test.

---

## 8. Risks & rollback

| Risk                                                                          | Mitigation                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| markdown-it output differs subtly from Kramdown (spacing, wrapping, entities) | Visual regression (Playwright) + HTML diff on a sample of pages before cutover                         |
| A `{: … }` or `markdown="1"` edge case renders as literal text                | Grep the built `_site` for leftover `{:` / `markdown="1"`; fail CI if found                            |
| Math breaks (double-escaped `&amp;`, mangled delimiters)                      | `markdownTemplateEngine: false` + `find:latex` / `check:math` scripts on output                        |
| Broken internal links after path changes                                      | `check:links` + `check:cross-refs` against the built Eleventy site                                     |
| Regression discovered post-cutover                                            | Jekyll files stay in git history; `upstream` remote still builds — revert the `migrate/eleventy` merge |

**Rollback:** the whole conversion lives on `migrate/eleventy`. `main` stays on working
Jekyll until Phase 10 parity is signed off, so rollback is a branch away at any point.

---

## 9. Definition of done

- [ ] `npx eleventy` builds all 282 pages with zero leftover `{:` / `markdown="1"` / `{% raw %}`.
- [ ] Every `contents/<slug>.html` URL matches the Jekyll output path (D5).
- [ ] MathJax renders across a sampled set of chapters (spot-check + `check:math`).
- [ ] Search, TOC, prev/next, and the PWA/offline flow all work against `_site`.
- [ ] `check:links`, `check:cross-refs`, `check:orphans`, `check:figures` pass on the build.
- [ ] GitHub Pages deploys `physics-book2` from the Eleventy workflow.
- [ ] `Gemfile`, `Gemfile.lock`, `_config.yml`, `_layouts/` removed; README/CONTRIBUTE updated.

---

## 10. References

- [`doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md`](doc/JEKYLL_TO_ELEVENTY_MIGRATION_PLAN.md) — detailed, code-level plan (Phases 1–10).
- [`doc/KRAMDOWN_MIGRATION_REVIEW.md`](doc/KRAMDOWN_MIGRATION_REVIEW.md) — Kramdown-specific syntax review.
- [`doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md`](doc/JEKYLL_TO_MYSTMD_MIGRATION_ANALYSIS.md) — alternative target (MyST) analysis.
- [Eleventy docs](https://www.11ty.dev/docs/) · [markdown-it](https://github.com/markdown-it/markdown-it) · [markdown-it-attrs](https://github.com/arve0/markdown-it-attrs)
