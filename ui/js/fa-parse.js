/**
 * Fur Affinity page parsing. Pure functions over a DOM Document (from DOMParser), no imports and no network, so the same
 * code runs in the app and in tools/fa-test.mjs against the scrubbed fixtures in tools/fa-fixtures/.
 * The markup it reads is documented in claude/furaffinity.md. Everything here fails soft: a missing piece is just empty.
 */
export const FA_WEB = 'https://www.furaffinity.net';
export const FA_RATING = { general: 's', mature: 'q', adult: 'e' };

export const parseHtml = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html');

const abs = (u, base = FA_WEB + '/') => {
  try {
    return new URL(u, base).href;
  } catch {
    return '';
  }
};
/** Protocol-relative CDN links (`//d.furaffinity.net/...`) and ordinary ones; anything saved to disk (`./x_files/..`) is not a link. */
const cdn = (u) => {
  u = String(u || '').trim();
  if (u.startsWith('//')) return 'https:' + u;
  return /^https?:\/\//i.test(u) ? u : '';
};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const txt = (el) => clean(el?.textContent);
const num = (s) => {
  const m = /-?\d[\d,]*/.exec(String(s ?? ''));
  return m ? +m[0].replace(/,/g, '') : 0;
};
export const unixIso = (sec) => (+sec > 0 ? new Date(+sec * 1000).toISOString() : '');

/** `/user/some_name/` -> `some_name` (FA's lower-case URL name). */
export function nameFromHref(href) {
  const m = /\/user\/([^/?#]+)/i.exec(String(href || ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

/** Text of an element with line breaks kept (descriptions, bios). */
export function plainText(el) {
  if (!el) return '';
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      // a line break in the page's source is only a space, as in a browser: <br> and blocks are what make new lines
      if (c.nodeType === 3) out.push(c.nodeValue.replace(/\s+/g, ' '));
      else if (c.nodeType === 1) {
        const tag = c.tagName.toLowerCase();
        if (tag === 'br') out.push('\n');
        else if (tag === 'script' || tag === 'style') continue;
        else {
          const block = /^(p|div|h[1-6]|li|tr|section|blockquote|hr)$/.test(tag) || /\bbbcode_(center|right|left|quote|h[1-6]|hr)\b/.test(c.getAttribute('class') || '');
          if (block && out.length && !/\n$/.test(out[out.length - 1])) out.push('\n');
          walk(c);
          if (block) out.push('\n');
        }
      }
    }
  };
  walk(el);
  return out.join('').replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const STYLES = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', sup: 'sup', sub: 'sub', blockquote: 'quote', p: 'block', div: 'block', li: 'block' };

/**
 * Formatted text (a profile's bio) as plain data: strings and {t, kids} for bold, italic, headings, alignment, quotes, links,
 * user icons, line breaks and rules. Only these kinds come out, so the screen never receives the page's own markup. No more
 * than one empty line in a row is kept.
 */
export function richText(el) {
  if (!el) return [];
  const isBr = (n) => n?.t === 'br';
  const walk = (node) => {
    const out = [];
    let breaks = 0;
    const push = (n) => {
      if (isBr(n)) {
        if (++breaks > 2) return;
      } else if (typeof n !== 'string' || n.trim()) breaks = 0;
      out.push(n);
    };
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const t = c.nodeValue.replace(/\s+/g, ' ');
        if (t) push(t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      const cls = c.getAttribute('class') || '';
      if (/^(script|style|template|noscript|iframe)$/.test(tag) || /\bsmilie\b/.test(cls)) continue;
      if (tag === 'br') push({ t: 'br' });
      else if (tag === 'hr' || /\bbbcode_hr\b/.test(cls)) push({ t: 'hr' });
      else if (tag === 'img') push(clean(c.getAttribute('alt')));
      else if (tag === 'a') {
        const href = (c.getAttribute('href') || '').trim();
        const user = /\b(iconusername|linkusername)\b/.test(cls) ? nameFromHref(href) : '';
        if (user) {
          const img = c.querySelector('img');
          push({ t: 'user', user, name: txt(c), icon: cdn(img?.getAttribute('src')) });
          continue;
        }
        const url = href && !href.startsWith('#') ? abs(href) : '';
        const kids = walk(c);
        if (/^https?:\/\//i.test(url)) push({ t: 'a', href: url, kids: kids.length ? kids : [url] });
        else kids.forEach(push);
      } else {
        const colour = (/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})\s*(?:;|$)/i.exec(c.getAttribute('style') || '') || [])[1];
        if (colour) {
          const kids = walk(c);
          if (kids.length) push({ t: 'color', color: colour, kids });
          continue;
        }
        const level = (/^h([1-6])$/.exec(tag) || /\bbbcode_h([1-6])\b/.exec(cls) || [])[1];
        const kind = level ? 'h' : (/\bbbcode_(center|right|left|quote|b|i|u|s|sup|sub)\b/.exec(cls) || [])[1] || STYLES[tag];
        const kids = walk(c);
        if (!kind) kids.forEach(push);
        else if (kids.length) push(level ? { t: kind, level: +level, kids } : { t: kind, kids });
      }
    }
    return out;
  };
  const out = walk(el);
  const empty = (n) => isBr(n) || (typeof n === 'string' && !n.trim());
  while (out.length && empty(out[0])) out.shift();
  while (out.length && empty(out[out.length - 1])) out.pop();
  return out;
}

/* ------------------------------------------------------------------ page health */
/** How many people are on the site, from the footer: {total, guests, registered, other}. */
export function parseOnline(doc) {
  const el = doc.querySelector('.online-stats');
  if (!el) return null;
  const out = {};
  for (const m of clean(el.textContent).matchAll(/(\d[\d,]*)\s*(users online|guests?|registered|other)/gi)) {
    const k = m[2].toLowerCase();
    out[k.startsWith('users') ? 'total' : k.startsWith('guest') ? 'guests' : k] = +m[1].replace(/,/g, '');
  }
  return out.registered != null || out.total != null ? out : null;
}

/** What kind of page this is, whether it is a Cloudflare check, and who is signed in. */
export function inspect(doc) {
  const body = doc.body;
  const id = (body?.id || '').replace(/^pageid-/, '');
  const title = doc.title || '';
  const challenge = !id && (/just a moment|attention required|checking your browser|verify you are human/i.test(title) || !!doc.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, script[src*="challenge-platform"]'));
  const avatar = doc.querySelector('img.loggedin_user_avatar');
  return {
    kind: id || null,
    challenge,
    title,
    loggedIn: body?.dataset?.userLoggedIn === '1',
    me: clean(avatar?.getAttribute('alt')).toLowerCase() || '',
    online: parseOnline(doc),
  };
}

/* ------------------------------------------------------------------ thumbnails */
/** `//t.furaffinity.net/123@400-1700000000.jpg`, or a saved copy of it: pick the id, size and version out of the name. */
export function thumbParts(src) {
  const m = /(\d+)@(\d+)-(\d+)\.([a-z0-9]+)/i.exec(String(src || ''));
  return m ? { id: m[1], size: +m[2], ts: m[3], ext: m[4].toLowerCase() } : null;
}
export const thumbUrl = (id, ts, size = 400, ext = 'jpg') => `https://t.furaffinity.net/${id}@${size}-${ts}.${ext}`;

/** `u_name c_category t_theme s_species gender keyword ...` as found in every thumbnail's data-tags. */
export function parseTagString(s) {
  const out = { user: '', category: '', theme: '', species: '', keywords: [] };
  for (const t of String(s || '').split(/\s+/).filter(Boolean)) {
    if (t.startsWith('u_') && !out.user) out.user = t.slice(2).toLowerCase();
    else if (t.startsWith('c_') && !out.category) out.category = t.slice(2);
    else if (t.startsWith('t_') && !out.theme) out.theme = t.slice(2);
    else if (t.startsWith('s_') && !out.species) out.species = t.slice(2);
    else out.keywords.push(t);
  }
  return out;
}

/** The block of per-submission JSON that gallery, search and user pages carry. */
export function submissionData(doc) {
  try {
    return JSON.parse(doc.querySelector('script#js-submissionData')?.textContent || '{}') || {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ lists of thumbnails */
/**
 * Every submission thumbnail inside `root` (default: the whole page content), in page order, once each.
 * The mini gallery on a submission page uses `sid_` ids and is left out on purpose.
 */
export function parseFigures(doc, { root = '#site-content' } = {}) {
  const scope = doc.querySelector(root) || doc;
  const data = submissionData(doc);
  const out = [];
  const seen = new Set();
  for (const fig of scope.querySelectorAll('figure[id^="sid-"]')) {
    const id = fig.id.slice(4);
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const img = fig.querySelector('img');
    const t = parseTagString(img?.getAttribute('data-tags'));
    const caps = fig.querySelectorAll('figcaption p');
    const titleA = caps[0]?.querySelector('a');
    const userA = caps[1]?.querySelector('a');
    const meta = data[id] || {};
    const user = nameFromHref(userA?.getAttribute('href')) || t.user || String(meta.lower || '').toLowerCase();
    const cls = fig.className || '';
    const rating = (/\br-(general|mature|adult)\b/.exec(cls) || [])[1] || meta.icon_rating || 'general';
    const src = img?.getAttribute('src') || '';
    const parts = thumbParts(src);
    out.push({
      id,
      title: clean(titleA?.getAttribute('title') || titleA?.textContent || fig.querySelector('i[title]')?.getAttribute('title') || meta.title),
      user,
      display: clean(userA?.getAttribute('title') ? txt(userA) : meta.username) || user,
      rating,
      type: (/\bt-(image|text|audio)\b/.exec(cls) || [])[1] || 'image',
      category: t.category,
      theme: t.theme,
      species: t.species,
      keywords: t.keywords,
      thumb: parts ? thumbUrl(id, parts.ts, parts.size, parts.ext) : cdn(src),
      ts: parts?.ts || '',
      w: +img?.getAttribute('data-width') || 0,
      h: +img?.getAttribute('data-height') || 0,
      desc: meta.description ? String(meta.description) : '',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ paging */
/**
 * The address of the next page, taken from the page's own "Next" control (a GET form on gallery, search and browse pages),
 * so the app follows whatever paging FA uses instead of guessing numbers. null on the last page.
 */
export function nextPageUrl(doc, pageUrl) {
  for (const form of doc.querySelectorAll('form')) {
    if (/^post$/i.test(form.getAttribute('method') || '')) continue;
    if (['search-form', 'searchbox'].includes(form.id)) continue;
    for (const b of form.querySelectorAll('button, input[type="submit"]')) {
      const label = clean(b.tagName === 'INPUT' ? b.value : b.textContent);
      if (!/^next\b/i.test(label) || b.hasAttribute('disabled')) continue;
      let u;
      try {
        u = new URL(form.getAttribute('action') || pageUrl, pageUrl);
      } catch {
        continue;
      }
      if (!/(^|\.)furaffinity\.net$/i.test(u.hostname)) continue;
      for (const el of form.querySelectorAll('input[name]')) {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (['submit', 'button', 'file', 'password'].includes(ty) || el.name === b.getAttribute('name')) continue;
        if ((ty === 'checkbox' || ty === 'radio') && !el.hasAttribute('checked')) continue;
        u.searchParams.set(el.name, el.getAttribute('value') ?? '');
      }
      for (const s of form.querySelectorAll('select[name]')) {
        if (s.name === b.getAttribute('name')) continue;
        const o = s.querySelector('option[selected]') || s.querySelector('option');
        if (o) u.searchParams.set(s.name, o.getAttribute('value') ?? clean(o.textContent));
      }
      if (b.getAttribute('name')) u.searchParams.set(b.getAttribute('name'), b.getAttribute('value') ?? '');
      u.protocol = 'https:';
      return u.href;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ front page */
/** The four lists on the front page: art, writing, music, crafts. */
export function parseFrontpage(doc) {
  const sections = [
    ['art', '#gallery-frontpage-submissions', 'Art'],
    ['writing', '#gallery-frontpage-writing', 'Writing & poetry'],
    ['music', '#gallery-frontpage-music', 'Music & audio'],
    ['crafts', '#gallery-frontpage-crafts', 'Fursuiting & crafts'],
  ];
  return sections.map(([id, sel, name]) => ({ id, name, items: parseFigures(doc, { root: sel }) }));
}

/* ------------------------------------------------------------------ submission page */
export function parseSubmission(doc) {
  const page = doc.querySelector('#submission_page');
  if (!page) return null;
  const script = doc.querySelector('script[data-content-type]');
  const img = doc.querySelector('#submissionImg');
  const userA = page.querySelector('.submission-description-artist a[href*="/user/"]');
  const dispEl = page.querySelector('.c-usernameBlockSimple__displayName');
  const stat = (name) => num(page.querySelector(`.submission-page-stats div[title="${name}"] > div`)?.textContent);
  const labels = [...page.querySelectorAll('.submission-content-stats > span.highlight > span')].map(txt);
  const values = [...page.querySelectorAll('.submission-content-stats > span:not(.highlight) > span')].map(txt);
  const field = (k) => values[labels.indexOf(k)] || '';
  const rating = (/c-contentRating--(general|mature|adult)/.exec(page.querySelector('.submission-page-stats')?.innerHTML || '') || [])[1] || 'general';
  const tags = parseTagString(img?.getAttribute('data-tags'));
  const keywords = [...page.querySelectorAll('.submission-tags span.tags a[href*="/search/@keywords"]')].map(txt).filter(Boolean);
  const date = page.querySelector('.submission-description-header .popup_date');
  const dims = /(\d+)\s*x\s*(\d+)/i.exec(field('Resolution'));
  const type = script?.getAttribute('data-content-type') || (page.className.match(/page-content-type-(\w+)/) || [])[1] || 'image';
  const full = cdn(img?.getAttribute('data-fullview-src')) || cdn(script?.getAttribute('data-content-url'));
  const folders = [...page.querySelectorAll('.folder-list-container .submission-folder a.dotted')].map((a) => {
    const m = /\/folder\/(\d+)\/([^/?#]*)/.exec(a.getAttribute('href') || '');
    return m ? { id: m[1], slug: m[2], name: txt(a), count: num(a.getAttribute('title')) } : null;
  }).filter(Boolean);
  const idFrom = (u) => (/\/view\/(\d+)/.exec(u || '') || [])[1] || '';
  const nav = [...page.querySelectorAll('.minigallery-navigation a')];
  return {
    id: script?.getAttribute('data-content-id') || idFrom(doc.querySelector('meta[property="og:url"]')?.getAttribute('content')),
    type,
    ext: (script?.getAttribute('data-content-extension') || '').toLowerCase(),
    title: txt(page.querySelector('.submission-title h2')) || script?.getAttribute('data-artwork-title') || '',
    user: nameFromHref(userA?.getAttribute('href')) || String(script?.getAttribute('data-artist-name') || '').toLowerCase(),
    display: clean(dispEl?.textContent) || '',
    avatar: cdn(page.querySelector('img.submission-user-icon')?.getAttribute('src')),
    created: unixIso(date?.getAttribute('data-time')),
    desc: plainText(page.querySelector('.submission-description-text')),
    descRich: richText(page.querySelector('.submission-description-text')),
    views: stat('Views'),
    comments: stat('Comments'),
    favs: stat('Favorites'),
    rating,
    category: field('Category'),
    theme: field('Theme'),
    species: field('Species'),
    w: dims ? +dims[1] : 0,
    h: dims ? +dims[2] : 0,
    fileSize: field('File Size'),
    keywords: keywords.length ? keywords : tags.keywords,
    tagsAttr: tags,
    full,
    // writing: the text when the page itself carries it; music: the player's own file (guessed selectors: needs a saved story and song page to confirm)
    body: plainText(page.querySelector('.submission-writing, .submission-area .submission-writing')).trim(),
    audio: cdn(doc.querySelector('audio source')?.getAttribute('src') || doc.querySelector('audio')?.getAttribute('src')),
    preview: cdn(img?.getAttribute('data-preview-src')) || cdn(doc.querySelector('meta[property="og:image"]')?.getAttribute('content')),
    folders,
    newer: idFrom(nav.find((a) => /newer/i.test(a.textContent))?.getAttribute('href')),
    older: idFrom(nav.find((a) => /older/i.test(a.textContent))?.getAttribute('href')),
  };
}

/* ------------------------------------------------------------------ user pages */
/** The name block and tabs every user page (home, gallery, scraps, favorites) starts with. */
export function parseUserHeader(doc) {
  const head = doc.querySelector('userpage-nav-header');
  if (!head) return null;
  const nameA = head.querySelector('a.c-usernameBlock__userName');
  const watch = head.querySelector('#watch-button');
  const idLink = head.querySelector('a[href*="/user/id:"]');
  const title = head.querySelector('.user-title');
  const lower = nameFromHref(head.querySelector('userpage-nav-avatar a')?.getAttribute('href')) || nameFromHref(nameA?.getAttribute('href')) || '';
  return {
    lower,
    display: txt(head.querySelector('.js-displayName')) || lower,
    avatar: cdn(head.querySelector('userpage-nav-avatar img')?.getAttribute('src')),
    title: clean([...(title?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ')).replace(/\bRegistered:?/i, '').trim(),
    registered: unixIso(title?.querySelector('.popup_date')?.getAttribute('data-time')),
    uuid: (/\/user\/id:([0-9a-f-]+)/i.exec(idLink?.getAttribute('href') || '') || [])[1] || '',
    aliases: [...head.querySelectorAll('.user-nav-display-name-caret li')].map(txt).filter(Boolean),
    watching: watch ? /\/unwatch\//.test(watch.getAttribute('href') || '') : null,
    tabs: Object.fromEntries([...head.querySelectorAll('ul.user-nav-page-links a')].map((a) => [txt(a).toLowerCase(), a.classList.contains('current')])),
  };
}

/** A user's profile page (`/user/name`). */
export function parseUserpage(doc) {
  const head = parseUserHeader(doc);
  const page = doc.querySelector('#page-userpage');
  if (!head || !page) return null;
  const stats = {};
  for (const sec of page.querySelectorAll('.userpage-right-column')) {
    if (!/^stats$/i.test(txt(sec.querySelector('.section-header h2')))) continue;
    for (const m of clean(sec.querySelector('.section-body')?.textContent).matchAll(/([A-Za-z][A-Za-z ]*?):\s*(\d[\d,]*)/g)) stats[m[1].trim().toLowerCase()] = +m[2].replace(/,/g, '');
  }
  const count = (sel) => num(page.querySelector(`${sel} .section-header h3 a`)?.textContent);
  const people = (sel) => [...page.querySelectorAll(`${sel} .c-usernameBlockSimple a[href*="/user/"]`)]
    .map((a) => ({ user: nameFromHref(a.getAttribute('href')), display: txt(a) })).filter((x) => x.user);
  return {
    ...head,
    bio: plainText(page.querySelector('.userpage-layout-profile .userpage-profile')),
    bioRich: richText(page.querySelector('.userpage-layout-profile .userpage-profile')),
    stats,
    watchers: count('.watched-by-block'),
    watching_count: count('.is-watching-block'),
    fields: [...page.querySelectorAll('#userpage-contact-item .table-row')].map((r) => [txt(r.querySelector('.userpage-profile-question')), clean(r.textContent).replace(txt(r.querySelector('.userpage-profile-question')), '').trim()]).filter(([k]) => k),
    contacts: [...page.querySelectorAll('#userpage-contact .user-contact-item')].map((c) => ({ label: txt(c.querySelector('strong')), url: c.querySelector('a[href^="http"]')?.getAttribute('href') || '', text: txt(c.querySelector('a')) })),
    recentWatchers: people('.watched-by-block'),
    recentWatching: people('.is-watching-block'),
    featured: parsePreview(page.querySelector('#gallery-preview')),
    favPreview: parsePreview(page.querySelector('#favorite-preview')),
    profileId: parsePreview(page.querySelector('.section-submission')),
    journal: parseFeaturedJournal(page),
    latest: parseFigures(doc, { root: '#gallery-latest-submissions' }),
    latestFavs: parseFigures(doc, { root: '#gallery-latest-favorites' }),
    shouts: parseShouts(doc),
  };
}

/** One large picture on a profile (the featured submission, the latest favorite, or the "profile ID" picture): null when there is none. */
export function parsePreview(box) {
  const a = box?.querySelector('a[href*="/view/"] img')?.closest('a');
  const id = (/\/view\/(\d+)/.exec(a?.getAttribute('href') || '') || [])[1];
  if (!id) return null;
  const img = a.querySelector('img');
  const src = img.getAttribute('src') || '';
  const parts = thumbParts(src);
  const t = parseTagString(img.getAttribute('data-tags'));
  const date = box.querySelector('.preview_date .popup_date, .popup_date');
  return {
    id,
    title: txt(box.querySelector('.preview_title a')),
    user: t.user,
    // the profile ID picture carries no rating class: it stays empty rather than being guessed
    rating: (/\br-(general|mature|adult)\b/.exec(a.className || '') || [])[1] || '',
    type: 'image',
    category: t.category,
    theme: t.theme,
    species: t.species,
    keywords: t.keywords,
    thumb: parts ? thumbUrl(id, parts.ts, parts.size, parts.ext) : cdn(src),
    ts: parts?.ts || '',
    created: unixIso(date?.getAttribute('data-time')),
  };
}

/** The journal a profile puts forward: {id, title, created, text}, or null. */
export function parseFeaturedJournal(page) {
  for (const sec of page.querySelectorAll('.userpage-right-column')) {
    if (!/^featured journal$/i.test(txt(sec.querySelector('.section-header h2')))) continue;
    const id = (/\/journal\/(\d+)/.exec(sec.querySelector('a[href*="/journal/"]')?.getAttribute('href') || '') || [])[1];
    if (!id) return null;
    const body = sec.querySelector('.section-body');
    const head = body?.querySelector('h2');
    // the heading is the title followed by "(rating)": keep the words before the rating
    const parts = [];
    for (const n of head?.childNodes || []) {
      if (n.nodeType === 1 && /contentRating/i.test((n.id || '') + ' ' + (n.className || ''))) break;
      parts.push(n.textContent);
    }
    return {
      id,
      title: clean(parts.join('')).replace(/\s*\($/, ''),
      created: unixIso(body?.querySelector('.popup_date')?.getAttribute('data-time')),
      text: plainText(body?.querySelector('.user-submitted-links')),
    };
  }
  return null;
}

/**
 * The users on a watch list page: links to user pages whose text is the user's own name. That keeps the list itself and drops
 * everything else on the page (navigation, news, footer), which also link places but never with a user's name as their text.
 */
export function parseWatchNames(doc, root = '#site-content') {
  const scope = doc.querySelector(root) || doc.body || doc;
  const flat = (s) => String(s || '').toLowerCase().replace(/[\s_~@.\-]+/g, '');
  const out = new Set();
  for (const a of scope.querySelectorAll('a[href*="/user/"]')) {
    const m = /\/user\/([^/?#]+)/.exec(a.getAttribute('href') || '');
    if (!m) continue;
    let name = m[1];
    try { name = decodeURIComponent(name); } catch { /* keep */ }
    name = name.toLowerCase();
    if (/^[a-z0-9][a-z0-9_.~-]{0,39}$/.test(name) && flat(a.textContent) === flat(name)) out.add(name);
  }
  return [...out];
}

/** Shouts on a profile (markup not seen in a saved page yet: read defensively, empty when it does not match). */
export function parseShouts(doc) {
  const out = [];
  for (const c of doc.querySelectorAll('#shouts .comment_container, .shouts .comment_container, #page-comments .comment_container, .comment_container')) {
    const who = c.querySelector('a[href*="/user/"]');
    const text = plainText(c.querySelector('.comment_text, .comment-text, .user-submitted-links')).trim();
    const date = c.querySelector('.popup_date');
    if (!who || !text) continue;
    out.push({
      user: nameFromHref(who.getAttribute('href')),
      display: txt(c.querySelector('.js-displayName')),
      avatar: cdn(c.querySelector('img.comment_useravatar')?.getAttribute('src')),
      text,
      at: date?.getAttribute('title') || clean(date?.textContent) || '',
      created: unixIso(date?.getAttribute('data-time')),
    });
    if (out.length >= 40) break;
  }
  return out;
}

/** The folder list beside a gallery: [{name, folders: [{id, slug, name, count, active}]}]. */
export function parseFolders(doc) {
  const box = doc.querySelector('.folder-list .user-folders');
  if (!box) return [];
  const groups = [];
  let cur = null;
  for (const el of box.children) {
    if (el.classList.contains('default-folders')) continue;
    if (el.classList.contains('container-item-top')) {
      cur = { name: txt(el.querySelector('h4')), folders: [] };
      groups.push(cur);
    } else if (el.tagName === 'UL' && cur) {
      for (const li of el.children) {
        const a = li.querySelector('a[href*="/folder/"]');
        const m = /\/folder\/(\d+)\/([^/?#]*)/.exec(a?.getAttribute('href') || '');
        if (m) cur.folders.push({ id: m[1], slug: m[2], name: txt(a), count: num(a.getAttribute('title')), active: false });
        else if (li.classList.contains('active')) cur.folders.push({ id: '', slug: '', name: txt(li.querySelector('strong')), count: num(li.querySelector('strong')?.getAttribute('title')), active: true });
      }
    }
  }
  return groups.filter((g) => g.name !== 'Gallery Folders' || g.folders.length);
}

/** Which gallery a gallery-shaped page is showing: name of the folder, from its header. */
export function parseFolderTitle(doc) {
  return txt(doc.querySelector('.folder-description h3'));
}
