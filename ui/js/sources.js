/**
 * "Sites & tags" for a live board: one search per site, so a board can gather the same subject from several boorus
 * (spike_(mlp) on e621 and spike on Derpibooru). Tags differ from site to site, so each site has its own tag list.
 * Suggestions come from tags you have linked before and from each site's own autocomplete, and the pairs you confirm are
 * remembered (and synced) so the next board does not have to ask.
 */
import { h, pretty } from './util.js';
import { icon } from './icons.js';
import { boards, tagLinks } from './store.js';
import { providerList, getProvider } from './providers.js';
import { parseToken } from './search.js';
import { dialog, toast } from './ui.js';

const textOf = (terms) => terms.map((t) => (t.op === '+' ? '' : t.op) + t.t).join(' ');
const termsOf = (text) => String(text || '').split(/\s+/).map(parseToken).filter(Boolean);
const positives = (terms) => terms.filter((t) => t.op !== '-').map((t) => t.t);

/** "spike_(mlp)" -> "spike", "artist:foo_bar" -> "foo bar": what to type into another site's autocomplete. */
const looksLike = (tag) => tag.replace(/^[a-z]+:/, '').replace(/_\([^)]*\)$/, '').replace(/_/g, ' ').trim();

export async function editSources(board, onSaved) {
  const rows = [{ p: board.provider, text: textOf(board.terms || []) }, ...(board.sources || []).map((s) => ({ p: s.provider, text: textOf(s.terms) }))];
  const body = h('div', { class: 'srcedit' });

  const draw = () => {
    body.replaceChildren(
      h('p', { class: 'dlg-text' }, 'Each site gets its own tags, because they do not name things the same way. The picture is shown once if it is on more than one site, from the most generous site unless another copy is clearly bigger.'),
      ...rows.map((r, i) => {
        const input = h('input', { class: 'input', value: r.text, placeholder: 'tags for this site', spellcheck: 'false', oninput: () => (r.text = input.value) });
        const pick = h('select', { class: 'input', onchange: () => { r.p = pick.value; draw(); } }, providerList.map((p) => h('option', { value: p.id, selected: p.id === r.p }, p.name)));
        const sug = h('div', { class: 'f-chips' });
        const add = (tag) => { if (!termsOf(r.text).some((t) => t.t === tag)) { r.text = (r.text.trim() + ' ' + tag).trim(); input.value = r.text; } };
        const suggest = async () => {
          sug.replaceChildren(h('small', {}, 'Looking…'));
          const prov = getProvider(r.p), found = [];
          for (const [j, o] of rows.entries()) {
            if (j === i) continue;
            for (const t of positives(termsOf(o.text))) {
              const s = tagLinks.suggest(getProvider(o.p).credKey, t, prov.credKey);
              if (s) found.push({ tag: s, note: 'linked' });
            }
          }
          const other = rows.find((o, j) => j !== i && positives(termsOf(o.text)).length);
          if (other && prov.autocomplete) {
            try {
              for (const a of (await prov.autocomplete(looksLike(positives(termsOf(other.text))[0]))).slice(0, 6)) if (!found.some((f) => f.tag === a.name)) found.push({ tag: a.name, note: a.count ? String(a.count) : '' });
            } catch { /* suggestions are a nicety */ }
          }
          sug.replaceChildren(...(found.length ? found.map((f) => h('button', { class: 'chip', title: f.note === 'linked' ? 'You linked these before' : 'From this site\'s own search', onclick: () => add(f.tag) }, (f.note === 'linked' ? '★ ' : '+ ') + pretty(f.tag), f.note && f.note !== 'linked' ? h('small', {}, ' ' + f.note) : null)) : [h('small', {}, 'No suggestions. Type the tag as this site spells it.')]));
        };
        return h('div', { class: 'srcrow' },
          h('div', { class: 'srcline' }, pick, input,
            h('button', { class: 'btn', title: 'Suggest tags for this site', onclick: suggest, html: icon('search', 15) }),
            rows.length > 1 ? h('button', { class: 'ibtn', title: 'Remove this site', html: icon('close', 15), onclick: () => (rows.splice(i, 1), draw()) }) : null),
          sug);
      }),
      h('button', { class: 'btn', html: icon('plus', 15) + '<span>Add a site</span>', onclick: () => {
        const used = new Set(rows.map((r) => r.p));
        const next = providerList.find((p) => !used.has(p.id));
        if (!next) return toast('Every site is already here', { ms: 1600 });
        rows.push({ p: next.id, text: '' });
        draw();
      } }));
  };
  draw();

  const go = await dialog({ title: `Sites & tags · ${board.name}`, body, wide: true, actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: true, cls: 'primary' }] });
  if (!go) return;
  const parsed = rows.map((r) => ({ provider: r.p, terms: termsOf(r.text) }));
  if (parsed.some((r) => !positives(r.terms).length)) return toast('Every site needs at least one tag', { kind: 'err', ms: 2600 });
  if (new Set(parsed.map((r) => r.provider)).size !== parsed.length) return toast('Each site can only be listed once', { kind: 'err', ms: 2600 });
  // one plain tag on every site: that is a statement that they mean the same thing, so remember it
  if (parsed.length > 1 && parsed.every((r) => r.terms.length === 1 && r.terms[0].op === '+')) {
    tagLinks.link(parsed.map((r) => ({ key: getProvider(r.provider).credKey, tag: r.terms[0].t })));
  }
  boards.update(board.id, { provider: parsed[0].provider, terms: parsed[0].terms, sources: parsed.slice(1) });
  toast(parsed.length > 1 ? `“${board.name}” now reads ${parsed.length} sites` : `“${board.name}” reads one site`, { ms: 2200 });
  onSaved?.();
}
