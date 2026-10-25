import { h } from './util.js';
import { M } from './menus.js';
import { openExternal } from './actions.js';

/**
 * DText (the markup of e621 and Danbooru descriptions, wikis and comments) → DOM.
 * Covers what descriptions actually use: h1.–h6. headings, * lists, [quote], [section], [spoiler],
 * [code], [b] [i] [u] [s] [sup] [sub] [color], "text":links, [[wiki]] links, {{searches}} and
 * "post #123" style references. Links into the same site stay in the app (search a tag, open a pool);
 * everything else opens in the browser. Nothing is ever put in as HTML, so a description cannot inject markup.
 *
 * renderDText(src, { prov }) → <div class="dtext">
 */

const BLOCK = 'quote|section|spoiler|code|nodtext|table';
const BLOCK_OPEN = new RegExp(`^[ \\t]*\\[(${BLOCK})(?:[=,]([^\\]]*))?\\]`, 'i');
const BLOCK_NEXT = new RegExp(`(^|\\n)[ \\t]*\\[(${BLOCK})(?:[=,][^\\]]*)?\\]`, 'i');
const INLINE_TAGS = 'b|i|u|s|sup|sub|spoiler|tn|code|color|nodtext';
const CAT_COLORS = ['artist', 'contributor', 'copyright', 'character', 'species', 'general', 'meta', 'lore', 'invalid'];
// "post #123" and friends: the in-app ones, then where the rest live on the site
const REF_PATHS = { set: 'post_sets', user: 'users', comment: 'comments', forum: 'forum_posts', topic: 'forum_topics', wiki: 'wiki_pages', artist: 'artists', note: 'notes', flag: 'post_flags', ticket: 'tickets', record: 'user_feedbacks' };
const REFS = ['post', 'pool', ...Object.keys(REF_PATHS)];

/** Index of the [/name] that closes the tag opened before `from`, counting nested [name]s. -1 if none. */
function findClose(s, name, from) {
  const re = new RegExp(`\\[(/?)${name}(?:[=,][^\\]]*)?\\]`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(s));) {
    depth += m[1] ? -1 : 1;
    if (!depth) return [m.index, re.lastIndex];
  }
  return null;
}

export function renderDText(src, opts = {}) {
  const root = h('div', { class: 'dtext' });
  const s = String(src || '').replace(/\r\n?/g, '\n').replace(/^[ \t]*thumb #\d+[ \t]*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
  blocks(s, root, opts);
  return root;
}

function blocks(s, out, opts) {
  while (s) {
    const m = s.match(BLOCK_OPEN);
    if (m) {
      const name = m[1].toLowerCase(), arg = m[2];
      const close = findClose(s, name, m[0].length);
      // a block only when it ends its line too; "[spoiler]x[/spoiler] and more" is inline text
      if (close && /^[ \t]*(\n|$)/.test(s.slice(close[1]))) {
        const inner = s.slice(m[0].length, close[0]).replace(/^\n+|\n+$/g, '');
        out.append(blockEl(name, arg, inner, opts));
        s = s.slice(close[1]).replace(/^[ \t]*\n?/, '').replace(/^\n+/, '');
        continue;
      }
    }
    // plain text, up to the next line that opens a block
    const re = new RegExp(BLOCK_NEXT.source, 'gi');
    re.lastIndex = 1;
    const n = re.exec(s);
    const cut = n ? n.index + n[1].length : s.length;
    lines(s.slice(0, cut), out, opts);
    s = s.slice(cut).replace(/^\n+/, '');
  }
}

function blockEl(name, arg, inner, opts) {
  if (name === 'code') return h('pre', { class: 'dt-code' }, inner);
  if (name === 'nodtext') return h('p', {}, inner);
  if (name === 'table') return table(inner, opts);
  const body = h('div', { class: 'dt-body' });
  blocks(inner, body, opts);
  if (name === 'quote') return h('blockquote', { class: 'dt-quote' }, ...body.childNodes);
  if (name === 'spoiler') return spoiler('div', [...body.childNodes]);
  // [section], [section=Title], [section,expanded], [section,expanded=Title]
  const expanded = /^expanded\b/i.test(arg || '');
  const title = (arg || '').replace(/^expanded\s*=?\s*/i, '').trim();
  return h('details', { class: 'dt-section', open: expanded }, h('summary', {}, title ? inline(title, opts) : 'Show'), body);
}

function table(inner, opts) {
  const t = h('table', { class: 'dt-table' });
  const rows = inner.match(/\[tr\][\s\S]*?\[\/tr\]/gi) || [];
  for (const r of rows) {
    const cells = [...r.matchAll(/\[(td|th)\]([\s\S]*?)\[\/\1\]/gi)];
    t.append(h('tr', {}, cells.map((c) => h(c[1].toLowerCase(), {}, inline(c[2].trim(), opts)))));
  }
  return t;
}

const spoiler = (tag, kids) => h(tag, { class: 'dt-spoiler', title: 'Spoiler: click to show', onclick: (e) => { const el = e.currentTarget; if (!el.classList.contains('shown')) { e.preventDefault(); e.stopPropagation(); el.classList.add('shown'); el.removeAttribute('title'); } } }, kids);

/** Headings, lists, [hr] and paragraphs (a single newline is a line break, a blank line a new paragraph). */
function lines(text, out, opts) {
  let para = null, list = null;
  const endPara = () => (para = null);
  for (const line of text.split('\n')) {
    const hd = line.match(/^h([1-6])(?:#[\w-]+)?\.\s*(.*)$/i);
    const li = line.match(/^(\*+)\s+(.*)$/);
    if (!li) list = null;
    if (hd) {
      endPara();
      out.append(h('div', { class: 'dt-h dt-h' + hd[1], role: 'heading', 'aria-level': hd[1] }, inline(hd[2], opts)));
    } else if (li) {
      endPara();
      const depth = Math.min(li[1].length, 6);
      if (!list) out.append((list = [h('ul', { class: 'dt-list' })])[0]);
      while (list.length < depth) {
        const ul = h('ul', { class: 'dt-list' });
        (list[list.length - 1].lastElementChild || list[list.length - 1]).append(ul);
        list.push(ul);
      }
      list.length = depth;
      list[depth - 1].append(h('li', {}, inline(li[2], opts)));
    } else if (/^\s*\[hr\]\s*$/i.test(line)) {
      endPara();
      out.append(h('hr', { class: 'dt-hr' }));
    } else if (!line.trim()) {
      endPara();
    } else {
      if (para) para.append(h('br'));
      else out.append((para = h('p')));
      para.append(...inline(line, opts));
    }
  }
}

/* ---------------------------------------------------------------- inline */

// one alternation, tried left to right; the group that matched says what was found
const INLINE = [
  `\\[(${INLINE_TAGS})(?:=([^\\]]+))?\\]`, // 1 tag, 2 arg
  '`([^`\\n]+)`', // 3 inline code
  '"([^"\\n]+)":\\[([^\\]\\s]+)\\]', // 4 text, 5 url  ("text":[url])
  '"([^"\\n]+)":((?:https?://|/|#)[^\\s<>"]*[^\\s<>".,;:!?)\\]])', // 6 text, 7 url
  '\\[\\[([^\\]|\\n]+)(?:\\|([^\\]\\n]*))?\\]\\]', // 8 wiki page, 9 label
  '\\{\\{([^}|\\n]+)(?:\\|([^}\\n]*))?\\}\\}', // 10 search, 11 label
  `\\b(${REFS.join('|')}) #(\\d+)`, // 12 kind, 13 id
  '<(https?://[^>\\s]+)>', // 14 url
  '(https?://[^\\s<>"]*[^\\s<>".,;:!?)\\]])', // 15 bare url
  `\\[/?(?:${BLOCK}|${INLINE_TAGS}|hr|tr|td|th)(?:[=,][^\\]]*)?\\]`, // stray tag: drop it
].join('|');

function inline(s, opts) {
  const out = [];
  const re = new RegExp(INLINE, 'gi'); // its own, since links and tags recurse
  let at = 0;
  for (let m; (m = re.exec(s));) {
    if (m.index > at) out.push(s.slice(at, m.index));
    at = re.lastIndex;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const close = findClose(s, name, at);
      if (!close) continue; // an opener with no closer is dropped
      const inner = s.slice(at, close[0]);
      at = close[1];
      out.push(tagEl(name, m[2], inner, opts));
      re.lastIndex = at;
    } else if (m[3]) out.push(h('code', { class: 'dt-icode' }, m[3]));
    else if (m[4]) out.push(link(m[5], inline(m[4], opts), opts));
    else if (m[6]) out.push(link(m[7], inline(m[6], opts), opts));
    else if (m[8]) out.push(wikiLink(m[8], m[9], opts));
    else if (m[10]) out.push(searchLink(m[10], m[11], opts));
    else if (m[12]) out.push(refLink(m[12].toLowerCase(), m[13], m[0], opts));
    else if (m[14] || m[15]) out.push(link(m[14] || m[15], [m[14] || m[15]], opts));
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

function tagEl(name, arg, inner, opts) {
  if (name === 'code') return h('code', { class: 'dt-icode' }, inner);
  if (name === 'nodtext') return document.createTextNode(inner);
  const kids = inline(inner, opts);
  switch (name) {
    case 'b': return h('b', {}, kids);
    case 'i': return h('i', {}, kids);
    case 'u': return h('u', {}, kids);
    case 's': return h('s', {}, kids);
    case 'sup': return h('sup', {}, kids);
    case 'sub': return h('sub', {}, kids);
    case 'tn': return h('small', { class: 'dt-tn' }, kids);
    case 'spoiler': return spoiler('span', kids);
    case 'color': {
      const c = String(arg || '').trim().toLowerCase();
      if (CAT_COLORS.includes(c)) return h('span', { style: { color: `var(--c-${c})` } }, kids);
      // only plain colour names and hex values, never arbitrary CSS
      return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/.test(c) ? h('span', { style: { color: c } }, kids) : h('span', {}, kids);
    }
  }
  return h('span', {}, kids);
}

/* ---------------------------------------------------------------- links */

const a = (title, kids, run) => h('a', { href: '#', class: 'dt-link', title, onclick: (e) => (e.preventDefault(), e.stopPropagation(), run()) }, kids);
const tagOf = (t) => t.trim().toLowerCase().replace(/\s+/g, '_');

function link(url, kids, opts) {
  const web = opts.prov?.web || '';
  if (/^\//.test(url) && web) url = web + url;
  if (!/^https?:\/\//i.test(url)) return h('span', {}, kids);
  const inApp = web && internal(url, web, opts);
  return a(url, kids, inApp || (() => openExternal(url)));
}

/** A link to the same site that the app can show itself: a post, a pool, a tag search or a wiki page. */
function internal(url, web, opts) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.host.replace(/^www\./, '') !== new URL(web).host.replace(/^www\./, '')) return null;
  const pv = opts.prov.id;
  let m;
  if ((m = u.pathname.match(/^\/pools\/(\d+)\/?$/))) return () => M.openPoolPage(+m[1], pv);
  if ((m = u.pathname.match(/^\/posts\/(\d+)\/?$/))) return () => M.tagAction('id:' + m[1], 'only', pv);
  if (/^\/posts\/?$/.test(u.pathname) && u.searchParams.get('tags')) return () => search(u.searchParams.get('tags'), pv);
  if ((m = u.pathname.match(/^\/wiki_pages\/(?:show_or_new)?\/?(.*)$/))) {
    const t = u.searchParams.get('title') || decodeURIComponent(m[1] || '');
    if (t && !/^\d+$/.test(t)) return () => M.tagAction(tagOf(t), 'only', pv);
  }
  return null;
}

function search(q, pv) {
  const terms = q.trim().split(/\s+/).filter(Boolean).map((t) => (t.startsWith('-') ? { t: t.slice(1), op: '-' } : { t, op: '+' }));
  if (!terms.length) return;
  // tagAction closes the viewer/reader and leaves for Roam; the full search then replaces that one step
  M.tagAction(terms[0].t, 'only', pv);
  if (terms.length > 1 || terms[0].op === '-') setTimeout(() => location.replace(M.roamHash(terms, {}, pv)));
}

function wikiLink(page, label, opts) {
  const text = (label || page).replace(/_/g, ' ').trim();
  if (!opts.prov?.web) return h('span', {}, text);
  const pv = opts.prov.id;
  return a('Search ' + tagOf(page), text, () => M.tagAction(tagOf(page), 'only', pv));
}

function searchLink(q, label, opts) {
  const text = (label || q).trim();
  if (!opts.prov?.web) return h('span', {}, text);
  return a('Search ' + q.trim(), text, () => search(q, opts.prov.id));
}

function refLink(kind, id, text, opts) {
  const web = opts.prov?.web;
  if (!web) return text;
  const pv = opts.prov.id;
  if (kind === 'post') return a('Post #' + id, text, () => M.tagAction('id:' + id, 'only', pv));
  if (kind === 'pool') return a('Pool #' + id, text, () => M.openPoolPage(+id, pv));
  const url = `${web}/${REF_PATHS[kind]}/${id}`;
  return a(url, text, () => openExternal(url));
}
