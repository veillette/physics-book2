#!/usr/bin/env node

/**
 * Equation Validation and Fixing Script
 *
 * Validates and optionally fixes equation issues including:
 * - Equation numbering consistency
 * - LaTeX syntax errors
 * - Unbalanced delimiters (braces, $, \left/\right)
 * - Equation references
 * - Common LaTeX mistakes
 * - Broken inline math
 *
 * Usage:
 *   node scripts/equations.js [options] [directory]
 *
 * Modes:
 *   Default (no flags): Check only, report issues
 *   --fix: Apply fixes to files
 *
 * Options:
 *   --fix              Apply fixes to files
 *   --strict           Enable stricter validation
 *   --help, -h         Show help message
 */

import path from 'path';
import { pathToFileURL } from 'url';
import matter from '@11ty/gray-matter';
import { createIssue, checkBraceBalance, getLineNumber } from './lib/parser.js';
import {
  printHeader,
  printDivider,
  printFileCount,
  printDryRunNotice,
  printStrictModeNotice,
  printErrors,
  printWarnings,
  printFixes,
  printSuccess,
  printSummary,
  printOverview,
} from './lib/reporter.js';
import { runCli, createCheckFixFlags, getMode } from './lib/cli.js';
import { findMarkdownFiles, readFile } from './lib/files.js';

/**
 * Blank out front matter and fenced code blocks (preserving line count) so that only real
 * body text — where $$…$$ math can appear — remains. Line numbers are preserved because each
 * removed line becomes an empty string rather than being deleted.
 * @param {string} content - Full file content
 * @returns {string} - Content with non-math regions replaced by empty lines
 */
function maskNonMath(content) {
  let inCode = false;
  let inFront = false;
  let frontEnded = false;

  return content
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (t === '---' && !frontEnded) {
        inFront = !inFront;
        if (!inFront) frontEnded = true;
        return '';
      }
      if (inFront) return '';
      if (t.startsWith('```') || t.startsWith('~~~')) {
        inCode = !inCode;
        return '';
      }
      return inCode ? '' : line;
    })
    .join('\n');
}

/**
 * Net \left − \right count in a math expression. \leftarrow/\rightarrow (and other commands
 * whose name continues with a letter) are excluded via the (?![a-zA-Z]) guard.
 * @param {string} s - Math expression
 * @returns {number} - Positive if more \left, negative if more \right, 0 if balanced
 */
function leftRightImbalance(s) {
  const left = (s.match(/\\left(?![a-zA-Z])/g) || []).length;
  const right = (s.match(/\\right(?![a-zA-Z])/g) || []).length;
  return left - right;
}

/**
 * Equation validator and fixer class.
 */
class EquationProcessor {
  constructor(options = {}) {
    this.strict = options.strict || false;
    this.fix = options.fix || false;
    this.errors = [];
    this.warnings = [];
    this.fixes = [];
    this.filesModified = 0;
    this.equations = new Map(); // Map of chapter -> equation numbers
  }

  /**
   * Process all files in a directory.
   * @param {string} directory - Directory to process
   * @returns {Promise<boolean>} - Success status
   */
  async process(directory) {
    const emoji = this.fix ? '🔧' : '📐';
    const title = this.fix ? 'Equation Auto-Fix' : 'Equation Validation';

    printHeader(emoji, title);

    if (this.fix) {
      printDryRunNotice();
    } else if (this.strict) {
      printStrictModeNotice();
    }

    const files = await findMarkdownFiles(directory);
    printFileCount(files.length);

    for (const file of files) {
      await this.processFile(file);
    }

    // Only validate numbering in check mode
    if (!this.fix) {
      this.validateEquationNumbering();
    }

    this.printResults();

    return this.fix ? true : this.errors.length === 0;
  }

  /**
   * Process a single file.
   * @param {string} filePath - Path to file
   */
  async processFile(filePath) {
    const content = readFile(filePath);
    const fileName = path.basename(filePath);

    if (this.fix) {
      this.fixFile(filePath, content, fileName);
    } else {
      this.checkFile(filePath, content, fileName);
    }
  }

  /**
   * Check a file for equation issues.
   * @param {string} filePath - Path to file
   * @param {string} content - File content
   * @param {string} fileName - File name
   */
  checkFile(filePath, content, fileName) {
    const { data } = matter(content);

    // Math in this project is delimited by $$…$$ ONLY (a single $ is literal text, e.g.
    // currency). A $$…$$ span may cover several lines (display blocks / arrays), so it must
    // be validated as a whole rather than line-by-line. See validateMathSpans.
    this.validateMathSpans(fileName, content);

    // Per-line checks that don't depend on span boundaries: equation numbering (\tag) and
    // the sub/superscript style warnings.
    const lines = content.split('\n');
    let inCodeBlock = false;
    let inFrontMatter = false;
    let frontMatterEnded = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.trim() === '---') {
        if (!frontMatterEnded) {
          inFrontMatter = !inFrontMatter;
          if (!inFrontMatter) frontMatterEnded = true;
        }
        continue;
      }
      if (inFrontMatter) continue;

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      this.checkEquationNumbering(fileName, lineNum, line, data.chapterNumber);
      this.checkCommonLatexErrors(fileName, lineNum, line);
    }
  }

  /**
   * Fix a file for equation issues.
   *
   * Auto-fixing math is intentionally disabled. The math delimiter in this project is $$…$$
   * (a lone $ is literal text, e.g. currency), and a standalone `$$` on its own line is a
   * valid display-block delimiter. The previous heuristics — merging a standalone `$$` into
   * the preceding line, and deleting `$$\s*$$` — both corrupted correct content (they broke
   * display blocks and merged adjacent inline spans such as `$$A$$ $$B$$`). The structural
   * problems this script now detects (unbalanced braces/\left-\right, unclosed blocks, stray
   * delimiters) require human judgement to repair, so they are reported, not rewritten.
   *
   * @param {string} filePath - Path to file
   * @param {string} content - File content
   * @param {string} fileName - File name
   */
  fixFile(filePath, content, fileName) {
    // No-op: report only. See method doc for why auto-fixing math is unsafe here.
    void filePath;
    void content;
    void fileName;
  }

  // ===== VALIDATION METHODS =====

  /**
   * Validate every $$…$$ math span in a file. Spans may cross line boundaries, so this works
   * on the whole (front-matter- and code-block-masked) content rather than per line.
   * @param {string} file - File name
   * @param {string} content - Full file content
   */
  validateMathSpans(file, content) {
    const masked = maskNonMath(content);
    const positions = [];
    const re = /\$\$/g;
    let m;
    while ((m = re.exec(masked)) !== null) positions.push(m.index);

    // An odd number of $$ markers means one delimiter is unpaired: a display block was opened
    // and never closed (or a stray $$ was left behind). Downstream pairing is meaningless.
    if (positions.length % 2 !== 0) {
      const last = positions[positions.length - 1];
      this.errors.push(
        createIssue({
          file,
          line: getLineNumber(masked, last),
          message: 'Unclosed $$ math block (odd number of $$ delimiters)',
          text: masked.slice(last, last + 60).replace(/\n/g, ' '),
        })
      );
      return;
    }

    for (let i = 0; i + 1 < positions.length; i += 2) {
      const inner = masked.slice(positions[i] + 2, positions[i + 1]);
      const line = getLineNumber(masked, positions[i]);
      const preview = inner.replace(/\n/g, ' ').trim();

      if (inner.trim().length === 0) {
        this.errors.push(
          createIssue({ file, line, message: 'Empty math expression ($$ $$)', text: preview })
        );
        continue;
      }

      const { balanced, count } = checkBraceBalance(inner);
      if (!balanced) {
        this.errors.push(
          createIssue({
            file,
            line,
            message: `Unbalanced braces in math (${count > 0 ? '+' : ''}${count})`,
            text: preview,
          })
        );
      }

      const lr = leftRightImbalance(inner);
      if (lr !== 0) {
        this.errors.push(
          createIssue({
            file,
            line,
            message: `Unbalanced \\left/\\right in math (${lr > 0 ? '+' : ''}${lr})`,
            text: preview,
          })
        );
      }
    }
  }

  checkEquationNumbering(file, line, text, chapterNumber) {
    const tagMatch = text.match(/\\tag\{(\d+)\.(\d+)\}/);
    if (tagMatch) {
      const eqChapter = parseInt(tagMatch[1]);
      const eqNumber = parseInt(tagMatch[2]);

      if (!this.equations.has(eqChapter)) {
        this.equations.set(eqChapter, []);
      }
      this.equations.get(eqChapter).push({
        file,
        line,
        number: eqNumber,
      });

      if (chapterNumber && eqChapter !== chapterNumber) {
        this.warnings.push(
          createIssue({
            file,
            line,
            message: `Equation ${eqChapter}.${eqNumber} appears in Chapter ${chapterNumber}`,
            text: text.trim(),
            severity: 'warning',
          })
        );
      }
    }

    const refMatch = text.match(/\\ref\{eq:([^}]+)\}/);
    if (refMatch && this.strict) {
      this.warnings.push(
        createIssue({
          file,
          line,
          message: `Equation reference \\ref{eq:${refMatch[1]}} - verify label exists`,
          text: text.trim(),
          severity: 'warning',
        })
      );
    }
  }

  checkCommonLatexErrors(file, line, text) {
    // Skip image markdown lines
    if (text.trim().startsWith('![')) return;

    // Only style WARNINGS live here. Structural errors (unbalanced braces, unclosed blocks,
    // stray delimiters) are detected per math span in validateMathSpans — line-anchored regexes
    // like /\\frac\{[^}]*\}\{[^}]*$/ produced false positives on legitimate multi-line arrays.
    const errorPatterns = [
      {
        pattern: /([a-zA-Z]{2,})_([a-zA-Z0-9]+)(?![_{])/,
        message: 'Multi-character subscript without braces (use _{...})',
        warning: true,
      },
      {
        pattern: /([a-zA-Z]{2,})\^([a-zA-Z0-9]+)(?![\^{])/,
        message: 'Multi-character superscript without braces (use ^{...})',
        warning: true,
      },
    ];

    for (const { pattern, message, warning } of errorPatterns) {
      if (pattern.test(text)) {
        const issue = createIssue({
          file,
          line,
          message,
          text: text.trim(),
          severity: warning ? 'warning' : 'error',
        });

        if (warning) {
          this.warnings.push(issue);
        } else {
          this.errors.push(issue);
        }
      }
    }
  }

  validateEquationNumbering() {
    for (const [chapter, equations] of this.equations.entries()) {
      equations.sort((a, b) => a.number - b.number);

      // Check for gaps
      for (let i = 0; i < equations.length - 1; i++) {
        const current = equations[i].number;
        const next = equations[i + 1].number;

        if (next - current > 1) {
          this.warnings.push(
            createIssue({
              file: equations[i].file,
              line: equations[i].line,
              message: `Gap in equation numbering: ${chapter}.${current} followed by ${chapter}.${next}`,
              severity: 'warning',
            })
          );
        }
      }

      // Check for duplicates
      for (let i = 0; i < equations.length - 1; i++) {
        if (equations[i].number === equations[i + 1].number) {
          this.errors.push(
            createIssue({
              file: equations[i + 1].file,
              line: equations[i + 1].line,
              message: `Duplicate equation number: ${chapter}.${equations[i].number}`,
            })
          );
        }
      }
    }
  }

  // ===== RESULTS =====

  printResults() {
    printDivider();

    if (this.fix) {
      printFixes(this.fixes, this.filesModified, true);
    } else {
      printErrors(this.errors);
      printWarnings(this.warnings);

      if (this.errors.length === 0 && this.warnings.length === 0) {
        printSuccess('All equation checks passed!');
      }

      printDivider();
      printSummary(this.errors.length, this.warnings.length);

      // Print equation overview
      if (this.equations.size > 0) {
        const sortedChapters = Array.from(this.equations.keys()).sort((a, b) => a - b);
        const items = sortedChapters.map(chapter => ({
          label: `Chapter ${chapter}`,
          value: `${this.equations.get(chapter).length} numbered equation(s)`,
        }));
        printOverview('📊', 'Equation Overview', items);
      }
    }
  }
}

// CLI Configuration — only runs when this file is executed directly, so tests can import the
// class without triggering the CLI.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const flags = createCheckFixFlags();

  runCli({
    name: 'equations',
    description: `Validates and fixes equation issues including:
- Equation numbering consistency
- LaTeX syntax errors
- Unbalanced delimiters (braces, $, \\left/\\right)
- Equation references
- Common LaTeX mistakes
- Broken inline math`,
    flags,
    examples: [
      'node scripts/equations.js                    # Check only',
      'node scripts/equations.js --fix              # Apply fixes',
      'node scripts/equations.js --strict           # Stricter validation',
      'node scripts/equations.js contents/ch10*.md  # Check specific files',
    ],
    run: async options => {
      const mode = getMode(options);
      const processor = new EquationProcessor({
        strict: options.strict,
        fix: mode === 'fix' || mode === 'both',
      });

      return processor.process(options.directory);
    },
  });
}

export default EquationProcessor;
