#!/usr/bin/env node
// generate-census.js — measures the Kramdown content patterns that drive the
// Jekyll -> Eleventy migration and writes scripts/migration-census.json.
//
// The census is the single source of truth shared by two later tools:
//   - scripts/migrate-content.js (P5): the container allow-list — the converter
//     hard-errors on any markdown="1" class/tag not present here;
//   - scripts/compare-builds.js (P0.5): expected per-class element counts.
//
// Re-runnable and deterministic: run after any content change to refresh counts.
// Reference: roadmap.md sections 2.1 and 4.3.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentsDir = join(repoRoot, 'contents');
const outFile = join(repoRoot, 'scripts', 'migration-census.json');

const files = readdirSync(contentsDir)
  .filter(f => f.endsWith('.md'))
  .sort();

// Opening tags carrying markdown="1". Anchored to line start (after optional
// indentation): Kramdown requires the opening tag alone on its line, and this
// avoids false matches on "<f" inside math like `$${d}_{\text{o}}<f$$`.
// Tag name + full attribute span captured so we can pull class lists (including
// the known duplicate-class quirk) back out.
const openTagRe =
  /^[ \t]*<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\bmarkdown="1"((?:[^>"']|"[^"]*"|'[^']*')*)>/gm;
const classRe = /\bclass\s*=\s*"([^"]*)"/g;

const markdownBlockByName = {}; // primary container name -> count
const tagInventory = {}; // raw tag name -> count (e.g. div, figure)
let markdownBlockTotal = 0;

let ialCount = 0; // {: ... } attribute lists
let rawPairs = 0; // {% raw %} ... {% endraw %} pairs
let siteBaseurl = 0; // {{ site.baseurl }} occurrences
const deflistFiles = []; // files using ": definition" lines
const footnoteFiles = []; // files using [^ref] footnotes
const siteBaseurlFiles = [];

for (const file of files) {
  const src = readFileSync(join(contentsDir, file), 'utf8');

  let m;
  openTagRe.lastIndex = 0;
  while ((m = openTagRe.exec(src)) !== null) {
    markdownBlockTotal += 1;
    const tag = m[1];
    tagInventory[tag] = (tagInventory[tag] || 0) + 1;
    const attrs = m[2] + m[3];
    // Duplicate class attributes: Kramdown keeps the LAST value (roadmap 2.1 data quirk;
    // the "merge" note there was wrong). Primary container name = first token of the last
    // class attribute, else the tag name (figure/etc.).
    let lastClassTokens = null;
    let c;
    classRe.lastIndex = 0;
    while ((c = classRe.exec(attrs)) !== null) {
      const toks = c[1].trim().split(/\s+/).filter(Boolean);
      if (toks.length) lastClassTokens = toks;
    }
    const name = lastClassTokens ? lastClassTokens[0] : tag;
    markdownBlockByName[name] = (markdownBlockByName[name] || 0) + 1;
  }

  ialCount += (src.match(/\{:[^}]*\}/g) || []).length;
  rawPairs += (src.match(/\{%\s*raw\s*%\}/g) || []).length;
  const baseurlHits = (src.match(/\{\{\s*site\.baseurl\s*\}\}/g) || []).length;
  siteBaseurl += baseurlHits;
  if (baseurlHits) siteBaseurlFiles.push(file);
  if (/^: /m.test(src)) deflistFiles.push(file);
  if (/\[\^[^\]]+\]/.test(src)) footnoteFiles.push(file);
}

// The allow-list the P5 converter must accept (sorted, primary container names).
const allowedContainerNames = Object.keys(markdownBlockByName).sort();

const census = {
  generatedAt: new Date().toISOString().slice(0, 10),
  note:
    'Measured from contents/*.md after the P0.3 outlier fixes. ' +
    'Source of truth for the P5 converter allow-list and P0.5 comparator counts.',
  contentFileCount: files.length,
  markdownBlockTotal,
  markdownBlockByName: sortByValueDesc(markdownBlockByName),
  tagInventory: sortByValueDesc(tagInventory),
  allowedContainerNames,
  ialCount,
  rawTagCount: rawPairs,
  siteBaseurlCount: siteBaseurl,
  siteBaseurlFiles,
  deflistFileCount: deflistFiles.length,
  footnoteFileCount: footnoteFiles.length,
  footnoteFiles,
};

writeFileSync(outFile, JSON.stringify(census, null, 2) + '\n');

console.log(`Wrote ${outFile}`);
console.log(`  content files      : ${census.contentFileCount}`);
console.log(`  markdown="1" blocks: ${census.markdownBlockTotal}`);
console.log(`  container names    : ${allowedContainerNames.join(', ')}`);
console.log(`  IALs {: ... }      : ${census.ialCount}`);
console.log(`  {% raw %} tags     : ${census.rawTagCount}`);
console.log(`  {{ site.baseurl }} : ${census.siteBaseurlCount}`);
console.log(`  deflist files      : ${census.deflistFileCount}`);
console.log(`  footnote files     : ${census.footnoteFileCount}`);

function sortByValueDesc(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}
