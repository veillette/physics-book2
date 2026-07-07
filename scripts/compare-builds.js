#!/usr/bin/env node
// compare-builds.js — parity comparator for the Jekyll -> Eleventy migration.
//
// For every page present in both build trees it compares the semantic facets that
// must survive the engine swap (roadmap P0.4 / D5):
//   - heading id set
//   - images, in document order: {src, id, alt, title}   (title carries figure-caption math)
//   - a[href] multiset
//   - container-class census: div.problem/.solution/.example/.note/.abstract/
//     .glossary/.footnote-refs and <figure>
//   - math spans ($$..$$, $..$, \(..\), \[..\]) in document order, compared VERBATIM
//   - normalized body text (whitespace-collapsed, entity-decoded)
//
// Comparisons run on cheerio-parsed nodes, so v4's boolean-attribute formatting
// (`disabled` vs `disabled=""`) and entity encodings normalize automatically.
//
// Usage:
//   node scripts/compare-builds.js                       # ref=_site_jekyll_baseline, cand=_site
//   node scripts/compare-builds.js --cand _site_jekyll_baseline   # self-test (must be 100% PASS)
//   node scripts/compare-builds.js --ref DIR --cand DIR
//   node scripts/compare-builds.js --page ch19EnergyStoredInCapacitors   # one-page detail
//   node scripts/compare-builds.js --verbose
// Exit code 0 iff every shared page passes (and no page is missing from candidate).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- args ----
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
// resolve() honors absolute overrides while still resolving relative names against the repo root.
const refDir = resolve(repoRoot, argVal('--ref', '_site_jekyll_baseline'));
const candDir = resolve(repoRoot, argVal('--cand', '_site'));
const onlyPage = argVal('--page', null);
const verbose = args.includes('--verbose');

for (const [label, dir] of [
  ['ref', refDir],
  ['candidate', candDir],
]) {
  if (!existsSync(dir)) {
    console.error(`ERROR: ${label} build dir not found: ${dir}`);
    process.exit(2);
  }
}

// ---- facet extraction ----
const CONTAINER_SELECTORS = [
  'div.problem',
  'div.solution',
  'div.example',
  'div.note',
  'div.abstract',
  'div.glossary',
  'div.footnote-refs',
  'figure',
];
// Ordered alternation: $$..$$ before $..$ so display math isn't split.
const MATH_RE = /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$(?!\$)[^\n$]*?\$/g;

function extractFacets(html) {
  const $ = cheerio.load(html);
  const $body = $('body').length ? $('body') : $.root();

  const headingIds = [];
  $body.find('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const id = $(el).attr('id');
    if (id) headingIds.push(id);
  });

  const images = [];
  $body.find('img').each((_, el) => {
    const $el = $(el);
    images.push({
      src: $el.attr('src') || '',
      id: $el.attr('id') || '',
      alt: $el.attr('alt') || '',
      title: $el.attr('title') || '',
    });
  });

  const links = [];
  $body.find('a[href]').each((_, el) => links.push($(el).attr('href')));
  links.sort();

  const containers = {};
  for (const sel of CONTAINER_SELECTORS) containers[sel] = $body.find(sel).length;

  const text = $body.text();
  const math = text.match(MATH_RE) || [];
  const normText = text.replace(/\s+/g, ' ').trim();

  return { headingIds: headingIds.sort(), images, links, containers, math, normText };
}

// ---- facet comparison ----
function eqJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function firstTextDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const ctx = 45;
  return {
    at: i,
    ref: a.slice(Math.max(0, i - ctx), i + ctx),
    cand: b.slice(Math.max(0, i - ctx), i + ctx),
  };
}

function comparePage(refHtml, candHtml) {
  const r = extractFacets(refHtml);
  const c = extractFacets(candHtml);
  const failures = [];

  if (!eqJSON(r.headingIds, c.headingIds))
    failures.push({ facet: 'heading-ids', ref: r.headingIds, cand: c.headingIds });
  if (!eqJSON(r.images, c.images))
    failures.push({ facet: 'images', ref: r.images, cand: c.images });
  if (!eqJSON(r.links, c.links)) failures.push({ facet: 'links', ref: r.links, cand: c.links });
  if (!eqJSON(r.containers, c.containers))
    failures.push({ facet: 'containers', ref: r.containers, cand: c.containers });
  if (!eqJSON(r.math, c.math)) failures.push({ facet: 'math', ref: r.math, cand: c.math });
  if (r.normText !== c.normText)
    failures.push({ facet: 'text', diff: firstTextDiff(r.normText, c.normText) });

  return failures;
}

// ---- page enumeration ----
// Jekyll renders its own _includes/*.html and _layouts/*.html template files as pages into
// the baseline; those are not content and Eleventy does not emit them, so skip them.
const NON_CONTENT = /^(_includes|_layouts)\//;
function htmlFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        const rel = relative(root, full);
        if (!NON_CONTENT.test(rel)) out.push(rel);
      }
    }
  })(root);
  return out.sort();
}

const refPages = htmlFiles(refDir);
let pages = refPages;
if (onlyPage) {
  pages = refPages.filter(
    p => p === onlyPage || p.endsWith(`/${onlyPage}.html`) || p.endsWith(`${onlyPage}.html`)
  );
  if (pages.length === 0) {
    console.error(`No page in ref matches "${onlyPage}"`);
    process.exit(2);
  }
}

// ---- run ----
let pass = 0;
const failedPages = [];
const missingPages = [];

for (const rel of pages) {
  const candPath = join(candDir, rel);
  if (!existsSync(candPath)) {
    missingPages.push(rel);
    continue;
  }
  const failures = comparePage(
    readFileSync(join(refDir, rel), 'utf8'),
    readFileSync(candPath, 'utf8')
  );
  if (failures.length === 0) {
    pass += 1;
    if (verbose) console.log(`PASS  ${rel}`);
  } else {
    failedPages.push({ rel, failures });
    console.log(`FAIL  ${rel}  [${failures.map(f => f.facet).join(', ')}]`);
    if (onlyPage) printDetail(failures);
  }
}

function truncate(v, max = 600) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + ' …(truncated)' : s;
}

function printDetail(failures) {
  for (const f of failures) {
    console.log(`\n  ── ${f.facet} ──`);
    if (f.facet === 'text') {
      console.log(`  first diff at char ${f.diff.at}`);
      console.log(`  ref : …${f.diff.ref}…`);
      console.log(`  cand: …${f.diff.cand}…`);
    } else {
      console.log(`  ref : ${truncate(f.ref)}`);
      console.log(`  cand: ${truncate(f.cand)}`);
    }
  }
  console.log('');
}

// ---- summary ----
const total = pages.length;
console.log('\n────────────────────────────────────────');
console.log(`ref : ${relative(repoRoot, refDir)}`);
console.log(`cand: ${relative(repoRoot, candDir)}`);
console.log(`PASS ${pass}/${total} pages`);
if (missingPages.length) {
  console.log(`MISSING from candidate: ${missingPages.length}`);
  for (const m of missingPages.slice(0, 20)) console.log(`  - ${m}`);
  if (missingPages.length > 20) console.log(`  … and ${missingPages.length - 20} more`);
}
if (failedPages.length && !onlyPage) {
  console.log(`\nRe-run with --page <slug> for per-facet detail, e.g.:`);
  console.log(
    `  node scripts/compare-builds.js --page ${failedPages[0].rel.replace(/^.*\//, '').replace(/\.html$/, '')}`
  );
}
console.log('────────────────────────────────────────');

process.exit(failedPages.length === 0 && missingPages.length === 0 ? 0 : 1);
