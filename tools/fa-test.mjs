// Checks ui/js/fa-parse.js against the scrubbed Fur Affinity fixtures in tools/fa-fixtures/.
// Needs a browser for DOMParser: NODE_PATH=$(npm root -g) node tools/fa-test.mjs   (Playwright's Chromium; set CHROMIUM=/path if it is not found)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const { chromium } = req('playwright');
const common = readFileSync(join(here, 'fa-fixtures/_common.html'), 'utf8');
const [header, footer] = common.split('<!-- COMMON-FOOTER -->').map((s) => s.replace('<!-- COMMON-HEADER -->', ''));
const fixture = (name) => readFileSync(join(here, 'fa-fixtures', name + '.html'), 'utf8').replace('<!-- COMMON-HEADER -->', header).replace('<!-- COMMON-FOOTER -->', footer);
const src = readFileSync(join(here, '../ui/js/fa-parse.js'), 'utf8');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
await page.goto('about:blank');
await page.evaluate(async (code) => {
  window.P = await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
}, src);
const run = (html, fn, ...args) => page.evaluate(([h, f, a]) => { const doc = window.P.parseHtml(h); return new Function('P', 'doc', 'args', `return (${f})(P, doc, args)`)(window.P, doc, a); }, [html, fn.toString(), args]);

let n = 0;
const ok = (name, fn) => { try { fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } };

/* page health */
for (const f of ['frontpage', 'gallery', 'search', 'submission-image', 'userpage']) {
  const r = await run(fixture(f), (P, d) => P.inspect(d));
  ok(`${f}: inspect`, () => {
    assert.equal(r.loggedIn, true);
    assert.equal(r.me, 'testuser');
    assert.equal(r.challenge, false);
    assert.deepEqual(r.online, { total: 11915, guests: 989, registered: 10024, other: 902 });
  });
}
const wall = await run('<html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running"></div></body></html>', (P, d) => P.inspect(d));
ok('challenge page is recognised', () => { assert.equal(wall.challenge, true); assert.equal(wall.kind, null); });
const plain = await run('<html><head><title>Error</title></head><body><p>nope</p></body></html>', (P, d) => P.inspect(d));
ok('an unknown page is not a challenge', () => { assert.equal(plain.challenge, false); assert.equal(plain.kind, null); });

/* front page: four sections, a duplicate is dropped */
const fp = await run(fixture('frontpage'), (P, d) => P.parseFrontpage(d));
ok('frontpage sections', () => {
  assert.deepEqual(fp.map((s) => s.id), ['art', 'writing', 'music', 'crafts']);
  assert.equal(fp[0].items.length, 1, 'duplicate figure is listed once');
  const a = fp[0].items[0];
  assert.equal(a.id, '10000020'); assert.equal(a.user, 'user4'); assert.equal(a.rating, 'general'); assert.equal(a.type, 'image');
  assert.equal(a.thumb, 'https://t.furaffinity.net/10000020@200-1700000021.jpg');
  assert.equal(a.theme, 'vore'); assert.equal(a.species, 'unspecified_any'); assert.deepEqual(a.keywords, ['male', 'kw2', 'kw3']);
  assert.equal(fp[1].items[0].type, 'text'); assert.equal(fp[2].items[0].type, 'audio'); assert.equal(fp[3].items[0].rating, 'mature');
});

/* gallery */
const g = await run(fixture('gallery'), (P, d) => ({ items: P.parseFigures(d), next: P.nextPageUrl(d, 'https://www.furaffinity.net/gallery/user3/'), user: P.parseUserHeader(d), folders: P.parseFolders(d) }));
ok('gallery items', () => {
  assert.equal(g.items.length, 3);
  assert.equal(g.items[0].user, 'user3'); assert.equal(g.items[0].rating, 'mature'); assert.equal(g.items[1].rating, 'adult');
  assert.equal(g.items[1].thumb, 'https://t.furaffinity.net/10000016@400-1700000017.jpg');
  assert.equal(g.items[0].title, 'Sample Title'); assert.equal(g.items[0].desc, '[b]bbcode[/b] description');
  assert.ok(Math.abs(g.items[0].w / g.items[0].h - 104.703 / 200) < 1e-6);
});
ok('gallery next page comes from the Next form', () => assert.equal(g.next, 'https://www.furaffinity.net/gallery/user3/2/'));
ok('user header', () => {
  const u = g.user;
  assert.equal(u.lower, 'user3'); assert.equal(u.display, 'User3'); assert.equal(u.watching, true);
  assert.equal(u.title, 'Digital Artist'); assert.equal(u.uuid, '00000000-0000-0000-0000-000000000001'); assert.deepEqual(u.aliases, ['Old Name']);
  assert.equal(u.registered, '2023-11-14T22:13:28.000Z'); assert.equal(u.tabs.gallery, true); assert.equal(u.tabs.scraps, false);
});
ok('folder list', () => {
  assert.deepEqual(g.folders.map((x) => x.name), ['Group one', 'Group two']);
  assert.deepEqual(g.folders[0].folders.map((x) => [x.id, x.slug, x.name, x.count]), [['1000001', 'folder-slug', 'Folder A', 59], ['1000002', 'other-slug', 'Folder B', 161]]);
});
const fo = await run(fixture('gallery-folder'), (P, d) => ({ items: P.parseFigures(d), next: P.nextPageUrl(d, 'https://www.furaffinity.net/gallery/user3/folder/1000002/other-slug'), title: P.parseFolderTitle(d), folders: P.parseFolders(d) }));
ok('folder page: last page has no next, header names the folder, active folder is flagged', () => {
  assert.equal(fo.next, null); assert.equal(fo.title, 'Folder B');
  assert.deepEqual(fo.folders[0].folders.map((x) => [x.name, x.active]), [['Folder A', false], ['Folder B', true]]);
});
const sc = await run(fixture('scraps'), (P, d) => ({ items: P.parseFigures(d), user: P.parseUserHeader(d), next: P.nextPageUrl(d, 'https://www.furaffinity.net/scraps/user3/') }));
ok('scraps', () => { assert.equal(sc.items.length, 3); assert.equal(sc.user.tabs.scraps, true); assert.equal(sc.next, null); });

/* search: paging via the pagination form, page picker select is left out */
const se = await run(fixture('search'), (P, d) => ({ items: P.parseFigures(d), next: P.nextPageUrl(d, 'https://www.furaffinity.net/search/?q=testquery') }));
ok('search results and next page', () => {
  assert.equal(se.items.length, 2); assert.equal(se.items[0].user, 'user91'); assert.equal(se.items[0].rating, 'adult');
  assert.equal(se.next, 'https://www.furaffinity.net/search/?q=testquery&page=2');
});

/* submission */
const sub = await run(fixture('submission-image'), (P, d) => P.parseSubmission(d));
ok('submission', () => {
  assert.equal(sub.id, '10000028'); assert.equal(sub.type, 'image'); assert.equal(sub.ext, 'png');
  assert.equal(sub.title, 'Sample Title'); assert.equal(sub.user, 'user7'); assert.equal(sub.display, 'User7');
  assert.equal(sub.full, 'https://d.furaffinity.net/art/user7/1700000029/1700000029.user7_file.png');
  assert.equal(sub.preview, 'https://t.furaffinity.net/10000028@600-1700000029.jpg');
  assert.equal(sub.rating, 'mature'); assert.equal(sub.views, 8); assert.equal(sub.favs, 3); assert.equal(sub.comments, 0);
  assert.equal(sub.category, 'All'); assert.equal(sub.theme, 'Human'); assert.equal(sub.species, 'Human'); assert.equal(sub.w, 1024); assert.equal(sub.h, 768);
  assert.deepEqual(sub.keywords, ['male', 'kw2', 'kw3']);
  assert.equal(sub.desc, 'First line\nSecond line with a link');
  assert.deepEqual(sub.folders, [{ id: '1000038', slug: 'folder-slug', name: 'Folder name', count: 74 }]);
  assert.equal(sub.newer, '10000030'); assert.equal(sub.older, '10000032');
  assert.equal(sub.created, '2023-11-14T22:13:49.000Z');
  assert.ok(!JSON.stringify(sub).includes('KEY'), 'no action keys leak into parsed data');
});
const mini = await run(fixture('submission-image'), (P, d) => P.parseFigures(d));
ok('mini-gallery thumbnails are not listed as results', () => assert.equal(mini.length, 0));

/* user page */
const up = await run(fixture('userpage'), (P, d) => P.parseUserpage(d));
ok('user page', () => {
  assert.equal(up.lower, 'user3'); assert.equal(up.bio, 'Hello there\nSome bio text\nsecond line');
  assert.equal(up.stats.views, 100053); assert.equal(up.stats.submissions, 229); assert.equal(up.stats['comments earned'], 2514);
  assert.equal(up.watchers, 6242); assert.equal(up.watching_count, 69); assert.equal(up.featured, '10000057');
  assert.equal(up.latest.length, 2); assert.equal(up.latestFavs.length, 1); assert.equal(up.latestFavs[0].user, 'user95');
  assert.deepEqual(up.fields, [['Accepting Commissions', 'Yes']]);
  assert.deepEqual(up.contacts, [{ label: 'Website', url: 'https://example.com/', text: 'example.com' }]);
  assert.equal(up.latest[0].title, 'Sample Title');
});

await browser.close();
console.log(`${n} checks passed`);
