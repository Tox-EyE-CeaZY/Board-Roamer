import { h, ago, pretty, debounce } from './util.js';
import { icon } from './icons.js';
import { history, boards } from './store.js';
import { getProvider } from './providers.js';
import { toast, confirmDlg } from './ui.js';
import { bindContext } from './ctxmenu.js';

function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}

export function renderTrail(root, ctx) {
  let filter = '';
  const list = h('div', { class: 'trail' });
  const search = h('input', { class: 'input', placeholder: 'Filter your trail…', spellcheck: 'false', oninput: debounce((e) => { filter = e.target.value.trim().toLowerCase(); paint(); }, 120) });
  const paint = () => {
    const all = history.all().filter((e) => !filter || e.terms.some((t) => t.t.includes(filter)));
    if (!all.length) {
      list.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('trail', 64) }), h('h2', {}, filter ? 'Nothing matches' : 'No trail yet'), h('p', {}, 'Every search you run is remembered here so you can pick the path back up.')));
      return;
    }
    const frag = [];
    let day = '';
    for (const e of all) {
      const label = dayLabel(e.ts);
      if (label !== day) {
        day = label;
        frag.push(h('div', { class: 'tr-day' }, h('span', {}, label)));
      }
      const prov = getProvider(e.provider);
      const f = e.filters || {};
      const bits = [f.order && `sort ${f.order}`, f.score > 0 && `score ≥${f.score}`, f.age && `last ${f.age}`, f.media, f.shape].filter(Boolean);
      frag.push(h('div', { class: 'tr-node', 'data-ts': e.ts, 'data-hash': ctx.roamHash(e.terms, e.filters, e.provider), style: `--ph:${prov.color}` },
        h('i', { class: 'tr-pin' }),
        h('div', { class: 'tr-card cut', tabindex: 0, onclick: () => ctx.runEntry(e), onkeydown: (ev) => ev.key === 'Enter' && ctx.runEntry(e) },
          h('div', { class: 'tr-top' },
            h('span', { class: 'prov' }, prov.short),
            h('span', { class: 'tr-time' }, ago(e.ts)),
            e.thumbs?.length ? h('div', { class: 'tr-thumbs' }, e.thumbs.map((s) => h('img', { src: s, alt: '', loading: 'lazy', draggable: 'false' }))) : null,
          ),
          h('div', { class: 'tr-chips' }, e.terms.length ? e.terms.map((t) => h('span', { class: `mini op-${{ '+': 'inc', '-': 'exc', '~': 'any' }[t.op]}` }, (t.op === '-' ? '−' : t.op === '~' ? '≈' : '') + pretty(t.t))) : h('span', { class: 'mini op-inc' }, 'everything, newest first'),
            bits.map((b) => h('span', { class: 'mini flt' }, b))),
          h('div', { class: 'tr-act' },
            h('button', { title: 'Save as board', html: icon('save', 15), onclick: (ev) => { ev.stopPropagation(); ctx.saveSmart(e); } }),
            h('button', { title: 'Forget', html: icon('close', 15), onclick: (ev) => { ev.stopPropagation(); history.remove(e.ts); paint(); } })),
        )));
    }
    list.replaceChildren(...frag);
  };
  root.replaceChildren(
    h('div', { class: 'vhead' },
      h('div', {}, h('h1', {}, 'Trail'), h('p', {}, 'Where you’ve roamed, newest first')),
      h('div', { class: 'vhead-act' }, search,
        h('button', { class: 'btn', html: icon('trash', 16) + '<span>Clear</span>', onclick: async () => { if (history.all().length && await confirmDlg('Clear the trail?', 'This forgets all remembered searches. Boards are not affected.', 'Clear')) { history.clear(); paint(); toast('Trail cleared'); } } }))),
    list);
  paint();
  bindContext(list, (ev) => {
    const el = ev.target.closest('.tr-node');
    if (!el) return null;
    const e = history.all().find((x) => String(x.ts) === el.dataset.ts);
    if (!e) return null;
    const text = e.terms.map((t) => (t.op === '+' ? '' : t.op) + t.t).join(' ');
    return [
      { header: text || 'everything' },
      { label: 'Search again', icon: 'compass', run: () => ctx.runEntry(e) },
      ctx.tabsOn?.() && { label: 'Search in new tab', icon: 'plus', run: () => ctx.openTab(el.dataset.hash, text || 'Roam', e.thumbs?.[0]) },
      { label: 'Save as live board', icon: 'save', run: () => ctx.saveSmart(e) },
      { sep: true },
      { label: 'Copy search as text', icon: 'copy', run: () => navigator.clipboard.writeText(text) },
      { sep: true },
      { label: 'Forget this one', icon: 'close', run: () => { history.remove(e.ts); paint(); } },
      { label: 'Forget everything older', icon: 'trash', danger: true, run: () => { history.all().filter((x) => x.ts < e.ts).forEach((x) => history.remove(x.ts)); paint(); } },
    ];
  });
}
