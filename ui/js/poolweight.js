import { h, pretty } from './util.js';
import { icon } from './icons.js';
import { S, poolUnblur } from './store.js';
import { blacklistHit, blurHit, compileBlacklist } from './providers.js';

/*
 * How much of a pool (or comic) your blacklist covers, so one bad page never sinks a whole comic.
 *
 *   hide rules  – a pool is only hidden (or veiled) from the pool list when MORE than `poolMostly`% of its pages match.
 *                 Below that, the matching pages are hidden / veiled one by one inside the pool, as before.
 *   #blur rules – below `poolWarn`%  the matching pages are just blurred one by one;
 *                 from `poolWarn`%  the pool also says it has blurred pages;
 *                 above `poolMostly`% the pool says it is mostly made of that, and offers one button that unblurs every page.
 */

export const unblurKey = (provId, poolId) => `${provId}:${poolId}`;
export const ruleName = (line) => pretty(String(line).replace(/\s*#blur\b/gi, '').trim());

const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const ranked = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([line, n]) => ({ line, n, name: ruleName(line) }));

/** `posts`: every page, or a sample of them (`sampled`: the share is then an estimate). */
export function poolWeight(posts, sampled = false) {
  const hideRules = S('blacklistMode') === 'off' ? [] : compileBlacklist(S('blacklist') || []);
  const n = posts.length, hideBy = new Map(), blurBy = new Map();
  let hid = 0, blur = 0;
  for (const p of posts) {
    const hh = blacklistHit(p, hideRules);
    if (hh) (hid++, tally(hideBy, hh));
    const bh = blurHit(p);
    if (bh) (blur++, tally(blurBy, bh));
  }
  const mostly = (+S('poolMostly') || 50) / 100, warn = (+S('poolWarn') || 0) / 100;
  return {
    n, sampled, hidden: hid, blurred: blur,
    hide: !n || !hid ? 'none' : hid / n > mostly ? 'mostly' : 'some',
    blur: !n || !blur ? 'none' : blur / n > mostly ? 'mostly' : blur / n >= warn ? 'warn' : 'pages',
    hideRules: ranked(hideBy),
    blurRules: ranked(blurBy),
  };
}

/** "red" / "red and blue" / "red, blue and 2 more" */
export function ruleList(rules, max = 2) {
  const names = rules.slice(0, max).map((r) => r.name);
  const rest = rules.length - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}

/**
 * The notice at the top of a pool page (and in the reader): null when there is nothing worth saying.
 * `onChange` runs after the pool was unblurred / blurred again, so the caller can repaint its pages.
 */
export function poolNotice(w, { provId, poolId, kind, onChange, onClose }) {
  const what = kind === 'comic' ? 'comic' : 'pool';
  const key = unblurKey(provId, poolId);
  const of = (k) => `${k} of ${w.n} pages`;
  const close = onClose && h('button', { class: 'ibtn pn-x', title: 'Dismiss', html: icon('close', 15), onclick: (e) => (e.stopPropagation(), onClose()) });
  if (w.blur === 'mostly') {
    const un = poolUnblur.has(key);
    const btn = h('button', { class: 'btn' + (un ? '' : ' primary'), html: icon(un ? 'cloak' : 'eye', 15) + `<span>${un ? 'Blur again' : 'Unblur all pages'}</span>`, onclick: (e) => { e.stopPropagation(); poolUnblur.set(key, !un); onChange?.(); } });
    return h('div', { class: 'pool-note mostly' + (un ? ' clear' : '') },
      h('i', { html: icon('cloak', 18) }),
      h('div', { class: 'pn-txt' },
        un ? h('b', {}, `Showing every page unblurred`) : h('b', {}, `This ${what} is mostly made of `, h('em', {}, ruleList(w.blurRules)), ', which you blur'),
        h('small', {}, `${of(w.blurred)} match your #blur ${w.blurRules.length > 1 ? 'rules' : 'rule'}.${un ? '' : ' Unblur them all at once instead of one by one.'}`)),
      btn, close);
  }
  if (w.hide === 'mostly') {
    const how = S('blacklistMode') === 'hide' ? 'hidden' : 'veiled';
    return h('div', { class: 'pool-note hide' },
      h('i', { html: icon('cloak', 18) }),
      h('div', { class: 'pn-txt' }, h('b', {}, `Most of this ${what} is on your blacklist: `, h('em', {}, ruleList(w.hideRules))), h('small', {}, `${of(w.hidden)} are ${how}.`)),
      close);
  }
  if (w.blur === 'warn') {
    return h('div', { class: 'pool-note warn' },
      h('i', { html: icon('cloak', 16) }),
      h('div', { class: 'pn-txt' }, h('b', {}, `Contains blurred pages: `, h('em', {}, ruleList(w.blurRules))), h('small', {}, `${of(w.blurred)} are blurred until you reveal them.`)),
      close);
  }
  return null;
}
