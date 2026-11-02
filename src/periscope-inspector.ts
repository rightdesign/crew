/**
 * The inspector overlay a periscope proxy injects (EPIC-078 Map v1 §5, CREW-2880).
 *
 * Holding Alt/Option outlines the hovered element that carries a `data-source`
 * attribute (`<repo-relative path>:<line>`, added at compile time by the
 * repository's own transform, which stays the repository's job); a click posts
 * `{ path, line, component, url }` to the proxy's pointed route and copies
 * `path:line` to the clipboard. Escape leaves the mode. No DOM, text or
 * screenshot is ever sent. It is the same overlay the repositories' in-repo
 * first pass served (`periscope.inspector: repo`), moved here so every
 * repository gets one implementation.
 */

/** Where the proxy serves the overlay script. */
export const INSPECTOR_ROUTE = '/__periscope/inspector.js';
/** Where the overlay posts a click; the proxy appends it to the drop file. */
export const POINTED_ROUTE = '/__periscope/pointed';

export const INSPECTOR_SOURCE = `
const ROUTE = ${JSON.stringify(POINTED_ROUTE)};
let armed = false;
let off = false;
let current = null;
let toast = null;
const outline = document.createElement('div');
const label = document.createElement('div');
Object.assign(outline.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', outline: '2px solid #e11d8f', outlineOffset: '-1px', display: 'none' });
Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', font: '11px/1.3 ui-monospace, monospace', background: '#1f1f23', color: '#fff', padding: '2px 6px', borderRadius: '3px', display: 'none', maxWidth: '60vw', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
document.documentElement.append(outline, label);

function componentName(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  let fiber = key ? el[key] : null;
  while (fiber) {
    const t = fiber.type;
    if (typeof t === 'function' || (t && typeof t === 'object')) {
      const n = (typeof t === 'function' ? t.displayName || t.name : t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)));
      if (n) return n;
    }
    fiber = fiber.return;
  }
  return undefined;
}

function hide() {
  current = null;
  outline.style.display = 'none';
  label.style.display = 'none';
}

function sync() {
  if (!armed || off) { hide(); document.documentElement.style.cursor = ''; return; }
  document.documentElement.style.cursor = 'crosshair';
}

function show(el) {
  current = el;
  const r = el.getBoundingClientRect();
  Object.assign(outline.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  label.textContent = el.getAttribute('data-source') + (componentName(el) ? '  <' + componentName(el) + '>' : '');
  label.style.display = 'block';
  label.style.left = Math.max(0, r.left) + 'px';
  label.style.top = (r.top > 20 ? r.top - 20 : r.bottom + 2) + 'px';
}

function flash(text) {
  if (toast) toast.remove();
  toast = document.createElement('div');
  toast.textContent = text;
  Object.assign(toast.style, { position: 'fixed', zIndex: '2147483647', right: '12px', bottom: '12px', font: '12px ui-monospace, monospace', background: '#1f1f23', color: '#fff', padding: '6px 10px', borderRadius: '4px', pointerEvents: 'none' });
  document.documentElement.append(toast);
  setTimeout(() => { if (toast) { toast.remove(); toast = null; } }, 1500);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') { armed = true; off = false; sync(); }
  else if (e.key === 'Escape' && armed) { off = true; sync(); }
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { armed = false; off = false; sync(); } }, true);
window.addEventListener('blur', () => { armed = false; off = false; sync(); });

window.addEventListener('mousemove', (e) => {
  if (!armed || off) return;
  const target = e.target instanceof Element ? e.target.closest('[data-source]') : null;
  if (target) show(target); else hide();
}, true);

window.addEventListener('click', (e) => {
  if (!armed || off || !current) return;
  e.preventDefault();
  e.stopPropagation();
  const src = current.getAttribute('data-source');
  const i = src.lastIndexOf(':');
  const entry = { path: src.slice(0, i), line: Number(src.slice(i + 1)), component: componentName(current), url: location.href };
  fetch(ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); })
    .catch(() => flash('point failed'));
  if (navigator.clipboard) navigator.clipboard.writeText(src).catch(() => {});
  flash('pointed at ' + src);
}, true);
`;
