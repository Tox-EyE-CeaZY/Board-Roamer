//! How a Fur Affinity story or song looks in the viewer: not a picture, so a reading page or a player.
import { h, fmtNum } from './util.js';
import { icon } from './icons.js';

/** RTF to plain text, good enough to read (control words dropped, paragraphs kept). */
export function rtfToText(s) {
  return String(s)
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(+n < 0 ? +n + 65536 : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * `ctx`: { via(url) -> the address to load a picture or file from, openSite() }.
 * The element repaints itself with `el._refresh()` once the rest of the submission has arrived.
 */
export function makeDoc(post, ctx) {
  const root = h('div', { class: 'media doc ' + (post.kind === 'music' ? 'doc-music' : 'doc-story') });
  let loaded = null; // 'story' text, once read
  let loading = false;
  const head = () => [h('h2', {}, post.title || 'Untitled'), h('p', { class: 'doc-by' }, post.artists?.length ? 'by ' + post.artists.join(', ') : '')];

  const story = () => {
    const body = post.body || loaded;
    const readable = post.body || ['txt', 'rtf'].includes(post.ext);
    const kids = head();
    if (body) {
      const n = words(body);
      kids.push(h('p', { class: 'doc-meta' }, `${fmtNum(n)} words · about ${Math.max(1, Math.round(n / 220))} min`), h('div', { class: 'doc-body' }, body));
    } else if (post._lazy || (readable && !loading && loaded === null)) {
      kids.push(h('p', { class: 'doc-note' }, 'Loading the story…'));
      if (!post._lazy && readable && !loading) {
        loading = true;
        fetch(ctx.via(post.full)).then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))).then((t) => { loaded = post.ext === 'rtf' ? rtfToText(t) : t; }).catch(() => { loaded = ''; }).finally(() => (loading = false, paint()));
      }
    } else {
      if (post.desc) kids.push(h('div', { class: 'doc-body' }, post.desc));
      kids.push(h('p', { class: 'doc-note' }, readable ? 'The story could not be loaded here.' : `This story is a .${post.ext || 'file'} document, which can not be shown here.`),
        h('button', { class: 'btn primary', onclick: () => ctx.openSite(), html: icon('external', 15) + '<span>Read it on Fur Affinity</span>' }));
    }
    return kids;
  };

  const music = () => {
    const kids = head();
    const src = post.audio || post.full;
    kids.unshift(post.card ? h('div', { class: 'doc-cover doc-icon', html: icon('play', 54) }) : h('img', { class: 'doc-cover', src: ctx.via(post.thumb), alt: '', draggable: 'false' }));
    if (src) kids.push(h('audio', { class: 'doc-audio', controls: true, preload: 'none', src: ctx.via(src) }));
    else kids.push(h('p', { class: 'doc-note' }, post._lazy ? 'Loading…' : 'No audio file was found.'));
    if (post.desc) kids.push(h('div', { class: 'doc-body doc-desc' }, post.desc));
    return kids;
  };

  const paint = () => {
    if (!root.isConnected && root._painted) return;
    root._painted = true;
    root.replaceChildren(...(post.kind === 'music' ? music() : story()));
  };
  root._refresh = paint;
  paint();
  return root;
}
