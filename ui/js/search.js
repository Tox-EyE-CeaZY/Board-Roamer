import { h, debounce, fmtNum, pretty } from './util.js';
import { icon } from './icons.js';
import { S, tagc, subs, history as trailStore } from './store.js';
import { catName } from './providers.js';
import { popover, segmented } from './ui.js';
import { bindContext } from './ctxmenu.js';
import { isPhone } from './platform.js';

const OPS = ['+', '-', '~'];
const OP_GLYPH = { '+': '+', '-': '−', '~': '≈' };
const OP_TIP = { '+': 'Must have — click to exclude', '-': 'Excluded — click to make optional', '~': 'Any-of — click to require' };

const EXAMPLES = {
  e621: ['wolf  ~fox  ~coyote  -gore', 'artist_name  order:score', 'canine  score:>200  date:week', 'solo  ratio:>1  type:webm'],
  e926: ['wolf  ~fox  order:favcount', 'landscape  -text', 'artist_name  date:month'],
  danbooru: ['scenery  order:rank', 'artist_name', 'blue_sky  cloud'],
  gelbooru: ['scenery  sort:score', 'artist_name'],
  safebooru: ['scenery  sort:score', 'artist_name'],
};

export function parseToken(raw) {
  let op = '+', t = raw.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '_');
  if (t.startsWith('-')) (op = '-'), (t = t.slice(1));
  else if (t.startsWith('~')) (op = '~'), (t = t.slice(1));
  return t ? { t, op } : null;
}

export class SearchBar {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks; // getProv() onRun(terms) onFilters(f) onSaveBoard() onRoll()
    this.terms = [];
    this.filters = null;
    this.hi = -1;
    this.sugg = [];
    this.reqId = 0;

    this.chipsEl = h('div', { class: 'chips' });
    this.input = h('input', { class: 'q', type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Search tags' });
    this.chipsEl.append(this.input);
    this.blendBtn = h('button', { class: 'ibtn', title: 'Match mode', onclick: () => this.toggleBlend() });
    this.clearBtn = h('button', { class: 'ibtn', title: 'Clear all tags', html: icon('close', 16), onclick: () => (this.setTerms([]), this.commit(true)) });
    this.goBtn = h('button', { class: 'go', title: 'Roam (Enter)', html: icon('go', 20), onclick: () => this.commit(true) });
    this.dd = h('div', { class: 'sugg cut', hidden: true });
    this.field = h('div', { class: 'field cut' },
      h('i', { class: 'f-ic', html: icon('search', 18) }),
      this.chipsEl, this.clearBtn, this.blendBtn, this.goBtn);
    this.wrap = h('div', { class: 'field-wrap' }, this.field, this.dd);
    this.filterBtn = h('button', { class: 'ibtn big', title: 'Sort & filters', html: icon('sliders', 20), onclick: () => this.openFilters() });
    this.badge = h('b', { class: 'dotbadge', hidden: true });
    this.filterBtn.append(this.badge);
    this.rollBtn = h('button', { class: 'ibtn big', title: 'Surprise me — random order', html: icon('dice', 20), onclick: () => hooks.onRoll() });
    this.saveBtn = h('button', { class: 'ibtn big', title: 'Save this search as a board', html: icon('save', 20), onclick: () => hooks.onSaveBoard(this.saveBtn) });
    root.append(this.wrap, h('div', { class: 'strip-tools' }, this.filterBtn, this.rollBtn, this.saveBtn));

    this.run = debounce(() => hooks.onRun(this.terms), 800);
    this.fetchSugg = debounce((q) => this._fetch(q), 170);
    this.input.addEventListener('keydown', (e) => this._key(e));
    this.input.addEventListener('input', () => this._input());
    this.input.addEventListener('paste', (e) => {
      const txt = e.clipboardData.getData('text');
      if (/^https?:\/\//i.test(txt.trim()) && hooks.onLink?.(txt.trim())) return e.preventDefault(); // a link to a post or a search: open it
      if (/\s/.test(txt.trim())) {
        e.preventDefault();
        txt.split(/\s+/).forEach((x) => this._add(parseToken(x), true));
        this.commit(false);
      }
    });
    this.input.addEventListener('focus', () => { this.field.classList.add('focus'); if (!this.input.value) this._home(); });
    this.input.addEventListener('blur', () => setTimeout(() => (this.field.classList.remove('focus'), this._hideDD()), 140));
    this.chipsEl.addEventListener('pointerdown', (e) => e.target === this.chipsEl && (e.preventDefault(), this.input.focus()));
    this.field.addEventListener('pointerdown', (e) => {
      if (e.target === this.field) (e.preventDefault(), this.input.focus());
    });
    this._cycle();

    // right-click: chips get their own menu, the rest of the field gets paste / clear
    bindContext(this.field, (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const term = this.terms.find((t) => t.t === chip.dataset.t);
        if (!term) return null;
        const set = (op) => { term.op = op; this.paint(); this.commit(false); };
        return [
          { label: 'Must have', icon: 'plus', checked: term.op === '+', run: () => set('+') },
          { label: 'Exclude', icon: 'minus', checked: term.op === '-', run: () => set('-') },
          { label: 'Any of', icon: 'blend', checked: term.op === '~', run: () => set('~') },
          { sep: true },
          { label: 'Edit', icon: 'edit', run: () => this._edit(this.terms.indexOf(term)) },
          { label: 'Remove', icon: 'close', run: () => { this.terms.splice(this.terms.indexOf(term), 1); this.paint(); this.commit(false); } },
          { sep: true },
          ...(this.hooks.tagMenu?.(term.t, chip.className.match(/cat-(\w+)/)?.[1]).slice(1) || []),
        ];
      }
      return [
        { label: 'Paste tags', icon: 'copy', run: async () => { try { const t = await navigator.clipboard.readText(); t.split(/\s+/).forEach((x) => this._add(parseToken(x), true)); this.commit(false); } catch {} } },
        { label: 'Copy as text', icon: 'copy', disabled: !this.terms.length, run: () => navigator.clipboard.writeText(this.terms.map((t) => (t.op === '+' ? '' : t.op) + t.t).join(' ')) },
        { label: 'Match any of them', icon: 'union', disabled: this.terms.filter((t) => !t.t.includes(':')).length < 2, run: () => this.toggleBlend() },
        { sep: true },
        { label: 'Clear all tags', icon: 'close', danger: true, disabled: !this.terms.length, run: () => { this.setTerms([]); this.commit(true); } },
      ];
    });
  }

  /* ---------------- placeholder cycling */
  _cycle() {
    let i = 0;
    const tick = () => {
      const ex = EXAMPLES[this.hooks.getProv().id] || EXAMPLES.e621;
      this.input.placeholder = isPhone() ? (this.terms.length ? 'add tag…' : 'Search tags…') : this.terms.length ? 'add another tag…' : 'Try  ' + ex[i++ % ex.length];
      this._ph = setTimeout(tick, 3800);
    };
    tick();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  /* ---------------- state */
  setTerms(terms, silent = true) {
    // a different set of tags arriving from outside (e.g. the Following feed) starts collapsed again
    if (JSON.stringify(terms) !== JSON.stringify(this.terms)) this.expanded = false;
    this.terms = terms.map((t) => ({ ...t }));
    this.paint();
  }

  setFilters(f) {
    this.filters = f;
    const n = this.activeFilterCount();
    this.badge.hidden = !n;
    this.badge.textContent = n;
    this.filterBtn.classList.toggle('lit', n > 0);
  }

  activeFilterCount() {
    const f = this.filters;
    if (!f) return 0;
    return (f.order ? 1 : 0) + (f.score > 0 ? 1 : 0) + (Object.values(f.ratings).some((v) => !v) ? 1 : 0) + (f.media ? 1 : 0) + (f.shape ? 1 : 0) + (f.age ? 1 : 0);
  }

  commit(now) {
    now ? this.run.flush() : this.run();
  }

  _add(tok, silent) {
    if (!tok) return;
    const i = this.terms.findIndex((x) => x.t === tok.t);
    if (i >= 0) this.terms[i] = tok;
    else this.terms.push(tok);
    this.paint();
    if (!silent) this.commit(false);
  }

  toggleBlend() {
    const anyPlus = this.terms.some((t) => t.op === '+');
    this.terms.forEach((t) => {
      if (anyPlus && t.op === '+') t.op = '~';
      else if (!anyPlus && t.op === '~') t.op = '+';
    });
    this.paint();
    this.commit(true);
  }

  /* ---------------- rendering */
  paint() {
    const prov = this.hooks.getProv();
    [...this.chipsEl.querySelectorAll('.chip')].forEach((c) => c.remove());
    const COLLAPSE_AT = isPhone() ? 4 : 7;
    const many = this.terms.length >= COLLAPSE_AT;
    this.field.classList.toggle('collapsed', many && !this.expanded);
    if (many && !this.expanded) {
      const real = this.terms.filter((t) => !t.t.includes(':'));
      const allAny = real.length > 0 && real.every((t) => t.op === '~');
      const names = real.slice(0, 3).map((t) => pretty(t.t)).join(', ');
      this.chipsEl.insertBefore(h('button', { class: 'chip summary', title: 'Click to show every tag and edit them', onclick: () => { this.expanded = true; this.paint(); this.input.focus(); } },
        h('span', { class: 'op', html: icon(allAny ? 'union' : 'inter', 15) }),
        h('span', { class: 'ct' }, `${allAny ? 'Any of ' : ''}${this.terms.length} tags`),
        h('span', { class: 'ct preview' }, names + (real.length > 3 ? `  +${real.length - 3}` : '')),
        h('span', { class: 'ct expand', html: icon('down', 13) + '<span>edit</span>' })), this.input);
    } else {
      if (many) this.chipsEl.insertBefore(h('button', { class: 'chip collapse', title: 'Fold these tags away', onclick: () => { this.expanded = false; this.paint(); } }, h('span', { class: 'op', html: icon('up', 15) }), h('span', { class: 'ct' }, `Collapse ${this.terms.length} tags`)), this.input);
      this._paintChips(prov);
    }
    this._paintMeta(prov);
  }

  _paintChips(prov) {
    this.terms.forEach((term, idx) => {
      const isMeta = term.t.includes(':');
      const info = tagc.get(prov.id, term.t);
      const cat = isMeta ? 'meta' : info?.cat || 'general';
      const chip = h('span', { class: `chip op-${{ '+': 'inc', '-': 'exc', '~': 'any' }[term.op]} cat-${cat}${isMeta ? ' is-meta' : ''}`, 'data-t': term.t },
        h('button', { class: 'op', title: OP_TIP[term.op], onclick: () => { term.op = OPS[(OPS.indexOf(term.op) + 1) % 3]; this.paint(); this.commit(false); } }, OP_GLYPH[term.op]),
        h('span', { class: 'ct', title: info?.count ? `${fmtNum(info.count)} posts · double-click to edit` : 'double-click to edit', ondblclick: () => this._edit(idx) }, pretty(term.t)),
        h('button', { class: 'x', title: 'Remove', html: icon('close', 11), onclick: () => { this.terms.splice(idx, 1); this.paint(); this.commit(false); } }),
      );
      this.chipsEl.insertBefore(chip, this.input);
      if (!isMeta && !info && prov.tagInfo) this._learn(prov, term.t);
    });
  }

  _paintMeta(prov) {
    const any = this.terms.some((t) => t.op === '~');
    const plus = this.terms.some((t) => t.op === '+');
    this.blendBtn.hidden = this.terms.filter((t) => !t.t.includes(':')).length < 2;
    this.blendBtn.innerHTML = icon(any && !plus ? 'union' : 'inter', 18);
    this.blendBtn.title = any && !plus ? 'Matching ANY of these tags — click to require ALL' : 'Matching ALL tags — click to match ANY';
    this.blendBtn.classList.toggle('lit', any);
    this.clearBtn.hidden = !this.terms.length;
    this.field.classList.toggle('has', this.terms.length > 0);
    this.hooks.onEdit?.();
  }

  async _learn(prov, name) {
    try {
      const info = await prov.tagInfo(name);
      if (info) {
        tagc.set(prov.id, name, info);
        const c = this.chipsEl.querySelector(`.chip[data-t="${CSS.escape(name)}"]`);
        if (c) {
          c.className = c.className.replace(/cat-\w+/, 'cat-' + info.cat);
          c.querySelector('.ct').title = `${fmtNum(info.count)} posts · double-click to edit`;
        }
        this.hooks.onTagLearned?.(name, info);
      }
    } catch {}
  }

  _edit(idx) {
    const t = this.terms.splice(idx, 1)[0];
    this.paint();
    this.input.value = (t.op === '+' ? '' : t.op) + t.t;
    this.input.focus();
    this._input();
  }

  /* ---------------- input + suggestions */
  _key(e) {
    const dd = !this.dd.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!dd) return;
      e.preventDefault();
      const n = this.sugg.length;
      let v = this.hi + (e.key === 'ArrowDown' ? 1 : -1);
      if (v < -1) v = n - 1;
      if (v >= n) v = -1;
      this.hi = v;
      this._paintHi();
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ' ' || e.key === ',') {
      const v = this.input.value.trim();
      if (e.key === 'Tab' && !v) return;
      if (e.key === 'Tab' && !(dd && this.sugg.length)) return;
      e.preventDefault();
      if (dd && this.hi >= 0 && (e.key === 'Enter' || e.key === 'Tab')) return this._pick(this.sugg[this.hi]);
      if (e.key === 'Tab' && dd && this.sugg[0]) return this._pick(this.sugg[0]);
      if (v) {
        this._add(parseToken(v), false);
        this.input.value = '';
        this._hideDD();
      } else if (e.key === 'Enter') this.commit(true);
    } else if (e.key === 'Backspace' && !this.input.value && this.terms.length) {
      this.terms.pop();
      this.paint();
      this.commit(false);
    } else if (e.key === 'Escape') {
      this._hideDD();
      this.input.blur();
    }
  }

  _input() {
    if (!this.input.value) return this._home();
    const v = this.input.value.replace(/^[-~]/, '').trim();
    if (v.length < 2 || v.includes(':')) return this._hideDD();
    this.fetchSugg(v);
  }

  /** Empty-box dropdown: starred tags first, then recently used ones. */
  _home() {
    const prov = this.hooks.getProv();
    const have = new Set(this.terms.map((t) => t.t));
    const mk = (t, tag) => ({ name: t, cat: tagc.get(prov.id, t)?.cat || 'general', count: tagc.get(prov.id, t)?.count || 0, tag });
    const follows = subs.all().filter((x) => x.p === prov.credKey && !have.has(x.t)).slice(0, 8).map((x) => ({ ...mk(x.t, 'following'), cat: 'artist', count: x.count || 0 }));
    const starred = (S('starred') || []).filter((x) => x.p === prov.credKey && !have.has(x.t)).slice(0, 12).map((x) => ({ ...mk(x.t, 'starred'), cat: x.cat || tagc.get(prov.id, x.t)?.cat || 'general' }));
    const recent = [];
    const seen = new Set([...have, ...follows.map((x) => x.name), ...starred.map((x) => x.name)]);
    outer: for (const e of trailStore.all()) {
      if (e.provider !== prov.id) continue;
      for (const t of e.terms) {
        if (t.op === '-' || t.t.includes(':') || seen.has(t.t)) continue;
        seen.add(t.t);
        recent.push(mk(t.t, 'recent'));
        if (recent.length >= 10) break outer;
      }
    }
    this.sugg = [...follows, ...starred, ...recent];
    this.hi = -1;
    this.sugg.length ? this._paintDD() : this._hideDD();
  }

  async _fetch(q) {
    const id = ++this.reqId;
    const prov = this.hooks.getProv();
    try {
      const list = await prov.autocomplete(q.toLowerCase().replace(/\s+/g, '_'));
      if (id !== this.reqId || !this.input.value.trim()) return;
      list.forEach((t) => tagc.set(prov.id, t.name, { cat: t.cat, count: t.count }));
      this.sugg = list;
      this.hi = -1;
      this._paintDD();
    } catch {
      this._hideDD();
    }
  }

  _paintDD() {
    if (!this.sugg.length) return this._hideDD();
    const prefix = /^[-~]/.exec(this.input.value)?.[0] || '';
    this.dd.replaceChildren(...this.sugg.map((s, i) =>
      h('div', { class: `sg cat-${s.cat}`, 'data-i': i, onpointerdown: (e) => (e.preventDefault(), this._pick(s)) },
        h('i', { class: 'dot' }),
        h('span', { class: 'sg-n' }, (prefix ? prefix : '') + pretty(s.name)),
        s.alias ? h('span', { class: 'sg-al' }, '← ' + pretty(s.alias)) : null,
        h('span', { class: 'sg-c' }, s.tag === 'starred' ? '★ starred' : s.tag === 'following' ? '🔔 following' : s.tag === 'recent' ? 'recent' : catName(s.cat)),
        h('span', { class: 'sg-k' }, fmtNum(s.count)),
      )));
    this.dd.hidden = false;
  }

  _paintHi() {
    [...this.dd.children].forEach((c, i) => c.classList.toggle('hi', i === this.hi));
    this.dd.children[this.hi]?.scrollIntoView({ block: 'nearest' });
  }

  _hideDD() {
    this.dd.hidden = true;
    this.hi = -1;
    this.reqId++;
  }

  _pick(s) {
    const prefix = /^[-~]/.exec(this.input.value)?.[0] || '';
    this._add({ t: s.name, op: prefix === '-' ? '-' : prefix === '~' ? '~' : '+' }, false);
    this.input.value = '';
    this._hideDD();
    this.input.focus();
  }

  /* ---------------- filter popover */
  openFilters() {
    const prov = this.hooks.getProv();
    const f = JSON.parse(JSON.stringify(this.filters));
    const apply = debounce(() => {
      this.filters = f;
      this.setFilters(f);
      this.hooks.onFilters(f);
    }, 450);
    const set = (k, v) => {
      f[k] = v;
      apply();
    };
    const row = (label, ...c) => h('div', { class: 'frow' }, h('label', {}, label), h('div', {}, c));
    const body = h('div', { class: 'fpanel' });
    body.append(
      row('Sort', segmented(prov.sorts, f.order, (v) => set('order', v), 'wrap')),
      row('Min score',
        h('input', { class: 'input num', type: 'number', min: 0, step: 10, value: f.score || '', placeholder: '0', oninput: (e) => set('score', +e.target.value || 0) }),
        ...[25, 100, 500].map((n) => h('button', { class: 'chipbtn', onclick: (e) => { const i = e.target.parentElement.querySelector('input'); i.value = n; set('score', n); } }, '≥' + n))),
    );
    const ratings = h('div', { class: 'rate-row' });
    const paintR = () => ratings.replaceChildren(...['s', 'q', 'e'].map((r) => h('button', {
      class: `rbig r-${r}` + (f.ratings[r] ? ' on' : ''), title: { s: 'Safe', q: 'Questionable', e: 'Explicit' }[r],
      onclick: () => { f.ratings[r] = !f.ratings[r]; if (!Object.values(f.ratings).some(Boolean)) f.ratings[r] = true; paintR(); apply(); },
    }, h('b', {}, r.toUpperCase()), h('small', {}, { s: 'safe', q: 'quest.', e: 'explicit' }[r]))));
    paintR();
    body.append(row('Rating', ratings));
    if (prov.media) body.append(row('Media', segmented([['', 'Any'], ['still', 'Stills'], ['animated', 'Animated'], ['video', 'Video']], f.media, (v) => set('media', v))));
    if (prov.shapes) body.append(row('Shape', segmented([['', 'Any'], ['wide', 'Wide'], ['tall', 'Tall'], ['square', 'Square']], f.shape, (v) => set('shape', v))));
    if (prov.ages) body.append(row('Posted', segmented([['', 'Ever'], ['day', '24h'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']], f.age, (v) => set('age', v))));
    body.append(h('div', { class: 'fp-foot' },
      h('button', { class: 'btn', onclick: () => { Object.assign(f, { order: '', score: 0, media: '', shape: '', age: '', ratings: { s: true, q: true, e: true } }); apply.flush(); this.openFilters(); } }, 'Reset'),
      h('span', { class: 'hint' }, 'Applies as you change it')));
    popover(this.filterBtn, body, { align: 'right', cls: 'wide-pop' });
  }
}
