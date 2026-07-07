// markdown-it-raw-titles.js
// Kramdown copies a link/image title attribute nearly verbatim: it keeps backslash
// escapes (`\( 2T \)`, `\Delta L`) but resolves HTML entities (`&#x2019;`). markdown-it's
// unescapeAll does the OPPOSITE of what we want on the backslashes (collapses `\(` -> `(`),
// and our figure captions are built client-side from the img `title` (book-viewer.js) and
// contain LaTeX, so the backslashes must survive for MathJax/parity. This overrides
// md.helpers.parseLinkTitle to keep the raw slice but decode HTML entities only, so
// `fluid&#x2019;s` -> `fluid’s` (matching the baseline after entity normalisation) rather
// than being double-escaped to `&amp;#x2019;` by the renderer's escapeHtml.
import { decodeHTML } from 'entities';

export default function rawTitles(md) {
  md.helpers.parseLinkTitle = function parseLinkTitle(str, start, max, prev_state) {
    let code;
    let pos = start;
    const state = {
      ok: false,
      can_continue: false,
      pos: 0,
      str: '',
      marker: 0,
    };

    if (prev_state) {
      state.str = prev_state.str;
      state.marker = prev_state.marker;
    } else {
      if (pos >= max) return state;
      let marker = str.charCodeAt(pos);
      if (marker !== 0x22 /* " */ && marker !== 0x27 /* ' */ && marker !== 0x28 /* ( */) return state;
      start++;
      pos++;
      if (marker === 0x28) marker = 0x29; // "(" -> closing ")"
      state.marker = marker;
    }

    while (pos < max) {
      code = str.charCodeAt(pos);
      if (code === state.marker) {
        state.pos = pos + 1;
        state.str += decodeHTML(str.slice(start, pos)); // entities decoded, backslashes kept
        state.ok = true;
        return state;
      } else if (code === 0x28 /* ( */ && state.marker === 0x29 /* ) */) {
        return state;
      } else if (code === 0x5c /* \ */ && pos + 1 < max) {
        pos++;
      }
      pos++;
    }

    state.can_continue = true;
    state.str += decodeHTML(str.slice(start, pos));
    return state;
  };
}
