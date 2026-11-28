// Board Roamer's frame for the Fur Affinity window (sign-in, the quick check, Watch). It runs in every page of that window.
// The window has no system frame; this draws the title bar, a thin frame and the resize edges, in the app's own look.
// The page underneath is the real site and is not changed, only moved down by the height of the bar.
(() => {
  if (window.top !== window || window.__brFrame) return;
  window.__brFrame = 1;
  const MODE = '__MODE__';
  const post = (m) => { try { window.ipc.postMessage(m); } catch (e) { /* no ipc here */ } };
  const css = `
    :host{all:initial}
    .bar{position:fixed;z-index:2147483647;left:0;right:0;top:0;height:36px;display:flex;align-items:stretch;justify-content:space-between;
      background:#0a1113;border-bottom:1px solid #1f2d30;color:#e6efe4;font:600 12px/1 'JetBrains Mono','Cascadia Mono','Cascadia Code',Consolas,monospace;
      letter-spacing:.04em;user-select:none;-webkit-user-select:none;cursor:default}
    .drag{flex:1;display:flex;align-items:center;gap:10px;padding-left:14px;min-width:0}
    .mark{width:8px;height:8px;background:#9be84a;transform:rotate(45deg);flex:none}
    .name{color:#e6efe4}
    .mode{color:#8fa9a3;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mode::before{content:'/';margin-right:10px;color:#3a4d50}
    .safe{margin-left:auto;margin-right:10px;color:#6f8a84;font-weight:500;white-space:nowrap}
    button{all:unset;box-sizing:border-box;width:46px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#a9bcb6}
    button:hover{background:#16242a;color:#e6efe4}
    button.x:hover{background:#c0392b;color:#fff}
    svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.4}
    .frame{position:fixed;z-index:2147483646;inset:0;border:1px solid #2a3c40;pointer-events:none}
    .rz{position:fixed;z-index:2147483647}
    .n{top:0;left:8px;right:8px;height:4px;cursor:ns-resize}.s{bottom:0;left:8px;right:8px;height:5px;cursor:ns-resize}
    .e{right:0;top:8px;bottom:8px;width:5px;cursor:ew-resize}.w{left:0;top:8px;bottom:8px;width:5px;cursor:ew-resize}
    .ne{top:0;right:0;width:9px;height:9px;cursor:nesw-resize}.nw{top:0;left:0;width:9px;height:9px;cursor:nwse-resize}
    .se{bottom:0;right:0;width:9px;height:9px;cursor:nwse-resize}.sw{bottom:0;left:0;width:9px;height:9px;cursor:nesw-resize}
    @media (max-width:560px){.safe{display:none}}
  `;
  const mount = () => {
    if (document.getElementById('br-frame')) return;
    const host = document.createElement('div');
    host.id = 'br-frame';
    const root = host.attachShadow({ mode: 'closed' });
    const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h) e.innerHTML = h; return e; };
    const bar = el('div', 'bar');
    const drag = el('div', 'drag');
    drag.append(el('i', 'mark'), el('span', 'name', 'BOARD ROAMER'), el('span', 'mode'));
    drag.lastChild.textContent = MODE;
    const safe = el('span', 'safe');
    safe.textContent = 'fur affinity · your sign-in stays on their site';
    drag.append(safe);
    drag.addEventListener('mousedown', (e) => { if (e.button === 0) { post(e.detail === 2 ? 'fa:max' : 'fa:drag'); } });
    const btn = (c, svg, msg, title) => { const b = el('button', c, svg); b.title = title; b.addEventListener('click', () => post(msg)); return b; };
    bar.append(drag,
      btn('', '<svg viewBox="0 0 12 12"><path d="M1 6.5h10"/></svg>', 'fa:min', 'Minimize'),
      btn('', '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"/></svg>', 'fa:max', 'Maximize'),
      btn('x', '<svg viewBox="0 0 12 12"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9"/></svg>', 'fa:shut', 'Close'));
    const style = el('style');
    style.textContent = css;
    root.append(style, bar, el('div', 'frame'));
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const r = el('div', 'rz ' + d);
      r.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); post('fa:resize:' + d.toUpperCase()); } });
      root.append(r);
    }
    (document.documentElement || document).append(host);
    const pad = document.createElement('style');
    pad.textContent = 'html{padding-top:36px!important;box-sizing:border-box}';
    (document.head || document.documentElement).append(pad);
  };
  if (document.documentElement) mount(); else document.addEventListener('readystatechange', mount);
  document.addEventListener('DOMContentLoaded', mount);
})();
