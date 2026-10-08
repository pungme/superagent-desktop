/**
 * The scripts the browser tools run inside a page.
 *
 * One library, installed per frame as `window.__cove`, and a handful of calls
 * into it. Everything here is a string because it runs in the page, not in
 * main — and runs the same in the built-in pane and in a tab of the user's own
 * browser.
 *
 * What a "frame" is to these scripts: one document a script can be run in,
 * together with everything that document can reach by itself — its open shadow
 * roots (web components) and the iframes on its own origin. A frame on another
 * origin is out of reach from here and is read by running the same scripts in
 * it separately (see automation.ts).
 */

// Semantic tags/roles first — cheap and reliable. Modern SPA dashboards (ad
// managers, admin consoles) routinely style a plain <div>/<span> as a link or
// button with only a JS click handler and no role at all, which no selector
// list can fully anticipate; browser_click's x/y fallback covers that case by
// clicking exactly where a screenshot shows the target, the same way the iOS
// simulator tools click by pixel coordinate rather than by widget.
export const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], ' +
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="slider"], ' +
  '[contenteditable="true"], [contenteditable=""]'

/** Most elements one frame reports; the page says how many more there were. */
export const MAX_ELEMENTS = 200
/** Characters of page text per read; `textOffset` reads on from there. */
export const TEXT_WINDOW = 12000

const LIB = String.raw`
if (!window.__cove || window.__cove.v !== 4) window.__cove = (() => {
  const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const state = { v: 4, els: new Map(), files: [] };
  const view = (el) => el.ownerDocument.defaultView || window;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = view(el).getComputedStyle(el);
    return !(s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0');
  };
  // Where an element's own document sits inside this frame: zero for the
  // document itself, the iframe's corner for one nested in it. Worked out each
  // time, because a scroll moves it.
  const origin = (el) => {
    let x = 0, y = 0, w = view(el);
    while (w && w !== window) {
      let f = null;
      try { f = w.frameElement; } catch (e) { f = null; }
      if (!f) break;
      const r = f.getBoundingClientRect();
      x += r.x + f.clientLeft; y += r.y + f.clientTop;
      w = view(f);
    }
    return { x, y };
  };
  const center = (el) => {
    const r = el.getBoundingClientRect(), o = origin(el);
    return { x: Math.round(o.x + r.x + r.width / 2), y: Math.round(o.y + r.y + r.height / 2) };
  };
  // Every element this frame can reach: its document, the open shadow roots in
  // it, and the documents of iframes on its own origin.
  const walk = (root, visit) => {
    for (const el of root.querySelectorAll('*')) {
      visit(el);
      if (el.shadowRoot) walk(el.shadowRoot, visit);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let d = null;
        try { d = el.contentDocument; } catch (e) { d = null; }
        if (d && d.documentElement && isVisible(el)) walk(d, visit);
      }
    }
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // What a person would call it: its label, not its tag.
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : null))
        .filter(Boolean).map((n) => n.innerText || n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.innerText || l.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    const wrap = el.closest && el.closest('label');
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    return clean(el.getAttribute('title')) || undefined;
  };
  const isField = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const describe = (el, i) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase() || undefined;
    const c = center(el);
    const d = { index: i, tag, role: el.getAttribute('role') || undefined, type };
    const label = labelOf(el);
    if (label) d.label = label.slice(0, 120);
    if (isField(el)) {
      if (el.name) d.name = el.name;
      if (tag === 'select') {
        const opts = [...el.options];
        d.value = opts.filter((o) => o.selected).map((o) => clean(o.text)).join(', ') || undefined;
        d.options = opts.slice(0, 40).map((o) => clean(o.text) || o.value);
        if (opts.length > 40) d.moreOptions = opts.length - 40;
        if (el.multiple) d.multiple = true;
      } else if (type === 'checkbox' || type === 'radio') {
        d.checked = el.checked;
        if (el.value && el.value !== 'on') d.value = el.value;
      } else if (type === 'password') {
        // That one is filled, never what with.
        if (el.value) d.value = '(' + el.value.length + ' characters, hidden)';
      } else if (type === 'file') {
        d.value = [...(el.files || [])].map((f) => f.name).join(', ') || undefined;
      } else if (el.value) d.value = String(el.value).slice(0, 200);
      if (el.placeholder) d.placeholder = el.placeholder;
      if (el.required) d.required = true;
      if (el.readOnly) d.readonly = true;
    } else {
      const t = clean(el.innerText || el.textContent).slice(0, 120);
      if (t && t !== d.label) d.text = t;
      const pressed = el.getAttribute('aria-pressed'), on = el.getAttribute('aria-checked');
      if (on) d.checked = on === 'true';
      if (pressed) d.pressed = pressed === 'true';
      const exp = el.getAttribute('aria-expanded');
      if (exp) d.expanded = exp === 'true';
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') d.disabled = true;
    if (tag === 'a') d.href = (el.getAttribute('href') || '').slice(0, 200) || undefined;
    if (view(el) !== window) d.frame = 'iframe';
    else if (el.getRootNode() !== document) d.frame = 'web component';
    d.cx = c.x; d.cy = c.y;
    return d;
  };
  const interactive = () => {
    const found = [];
    walk(document, (el) => { if (el.matches(SEL) && isVisible(el)) found.push(el); });
    return found;
  };
  // The page's words: the document's own, then what innerText leaves out —
  // the insides of web components and of iframes on this origin.
  const pageText = () => {
    const parts = [(document.body && document.body.innerText) || ''];
    walk(document, (el) => {
      if (el.shadowRoot) {
        const t = [...el.shadowRoot.children].map((c) => c.innerText || '').join('\n').trim();
        if (t && !parts[0].includes(t.slice(0, 80))) parts.push(t);
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const b = el.contentDocument && el.contentDocument.body;
          if (b && isVisible(el) && b.innerText.trim()) parts.push('[in an iframe]\n' + b.innerText.trim());
        } catch (e) {}
      }
    });
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
  };
  state.read = (max, textOffset, textWindow) => {
    const all = interactive();
    state.els = new Map();
    const elements = all.slice(0, max).map((el, i) => { state.els.set(i, el); return describe(el, i); });
    state.files = [];
    walk(document, (el) => {
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file') state.files.push(el);
    });
    const text = pageText();
    return {
      url: location.href,
      title: document.title,
      text: text.slice(textOffset, textOffset + textWindow),
      textLength: text.length,
      elements,
      moreElements: Math.max(0, all.length - max),
      fileInputs: state.files.map((el, n) => ({
        input: n, label: labelOf(el), name: el.name || undefined,
        accept: el.getAttribute('accept') || undefined, multiple: el.multiple || undefined,
        hidden: !isVisible(el) || undefined
      })),
      scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight, viewport: window.innerHeight }
    };
  };
  const textOf = (el) => clean(el.innerText || el.value || '').toLowerCase();
  state.find = (target) => {
    if (target.index !== undefined) {
      const el = state.els.get(target.index);
      return el && el.isConnected ? el : null;
    }
    const needle = clean(target.text).toLowerCase();
    if (!needle) return null;
    const els = interactive();
    const names = (el) => [textOf(el), (labelOf(el) || '').toLowerCase(), (el.getAttribute('placeholder') || '').toLowerCase()];
    return els.find((el) => names(el).some((t) => t === needle)) ||
      els.find((el) => names(el).some((t) => t && t.includes(needle))) || null;
  };
  // Bring it on screen — its iframe first, when it is in one — and say where.
  state.locate = (target) => {
    const el = state.find(target);
    if (!el) return null;
    const chain = [];
    for (let w = view(el); w && w !== window; ) {
      let f = null;
      try { f = w.frameElement; } catch (e) { f = null; }
      if (!f) break;
      chain.unshift(f); w = view(f);
    }
    // Only when it is not already showing: moving a page that did not need
    // moving puts everything else somewhere new — the other end of a drag, a
    // point just read off a screenshot.
    const showing = (n) => {
      const r = n.getBoundingClientRect(), w = view(n);
      return r.top >= 0 && r.left >= 0 && r.bottom <= w.innerHeight && r.right <= w.innerWidth;
    };
    for (const n of [...chain, el]) if (!showing(n)) n.scrollIntoView({ block: 'center', inline: 'center' });
    return center(el);
  };
  state.select = (target, wanted) => {
    const el = state.find(target);
    if (!el) return { error: 'not found' };
    if (el.tagName !== 'SELECT') return { error: 'not a select', tag: el.tagName.toLowerCase(), role: el.getAttribute('role') };
    const opts = [...el.options];
    const want = wanted.map((w) => clean(w).toLowerCase());
    const pick = (w) => opts.find((o) => clean(o.text).toLowerCase() === w || o.value.toLowerCase() === w) ||
      opts.find((o) => clean(o.text).toLowerCase().includes(w));
    const chosen = want.map(pick);
    const missing = wanted.filter((_, i) => !chosen[i]);
    if (missing.length) return { error: 'no such option', missing, options: opts.slice(0, 40).map((o) => clean(o.text) || o.value) };
    if (chosen.some((o) => o.disabled)) return { error: 'option disabled' };
    if (el.disabled) return { error: 'select disabled' };
    if (el.multiple) for (const o of opts) o.selected = chosen.includes(o);
    else el.value = chosen[0].value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: opts.filter((o) => o.selected).map((o) => clean(o.text) || o.value) };
  };
  // The file input a tool call means: one named by its place in the page's
  // list of them, or by the element it is, or the only one there is.
  state.fileInput = (pick) => {
    const files = [];
    walk(document, (el) => {
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file') files.push(el);
    });
    if (pick.index !== undefined) {
      const el = state.els.get(pick.index);
      if (!el || !el.isConnected) return { error: 'not found' };
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file') { state.upload = el; return { ok: true, multiple: el.multiple }; }
      // A label or a styled button in front of the real input.
      const inside = el.querySelector && el.querySelector('input[type=file]');
      const forId = el.tagName === 'LABEL' && el.htmlFor ? el.getRootNode().getElementById(el.htmlFor) : null;
      const real = inside || forId;
      if (real) { state.upload = real; return { ok: true, multiple: real.multiple }; }
      return { error: 'not a file input', count: files.length };
    }
    if (pick.input !== undefined) {
      const el = files[pick.input];
      if (!el) return { error: 'no such input', count: files.length };
      state.upload = el; return { ok: true, multiple: el.multiple };
    }
    if (files.length === 1) { state.upload = files[0]; return { ok: true, multiple: files[0].multiple }; }
    return { error: files.length ? 'several' : 'none', count: files.length };
  };
  state.scroll = (opts) => {
    let target = null;
    if (opts.index !== undefined || opts.text) {
      target = state.find(opts);
      if (!target) return { error: 'not found' };
    }
    if (target && !opts.direction) {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } else {
      // The nearest thing that actually scrolls: the element's own scroller, or the page.
      let box = null;
      for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
        const s = view(n).getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) { box = n; break; }
      }
      const page = (target ? view(target) : window);
      const h = box ? box.clientHeight : page.innerHeight;
      const by = Math.round(h * (opts.pages || 0.85));
      const to = box || page;
      if (opts.direction === 'top') to.scrollTo({ top: 0 });
      else if (opts.direction === 'bottom') to.scrollTo({ top: box ? box.scrollHeight : page.document.documentElement.scrollHeight });
      else to.scrollBy({ top: opts.direction === 'up' ? -by : by });
    }
    const page = window, doc = document.documentElement;
    return { y: Math.round(page.scrollY), height: doc.scrollHeight, viewport: page.innerHeight,
      atTop: page.scrollY <= 1, atBottom: page.scrollY + page.innerHeight >= doc.scrollHeight - 2 };
  };
  // Where a child frame's document starts inside this one, so a point in it
  // can be turned into a point on the page. Matched by address, then by name,
  // then by its place among the frames.
  state.frameCorner = (url, name, nth, reveal) => {
    const frames = [];
    walk(document, (el) => { if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') frames.push(el); });
    const abs = (el) => { try { return new URL(el.getAttribute('src') || '', el.ownerDocument.baseURI).href; } catch (e) { return ''; } };
    const el = frames.find((f) => url && abs(f) === url) || (name ? frames.find((f) => f.name === name) : null) || frames[nth] || null;
    if (!el || !isVisible(el)) return null;
    if (reveal) {
      const b = el.getBoundingClientRect(), w = view(el);
      if (!(b.top >= 0 && b.left >= 0 && b.bottom <= w.innerHeight && b.right <= w.innerWidth))
        el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const r = el.getBoundingClientRect(), o = origin(el);
    return { x: o.x + r.x + el.clientLeft, y: o.y + r.y + el.clientTop, w: r.width, h: r.height };
  };
  return state;
})();`

const call = (body: string): string => `(() => { ${LIB}\n return ${body}; })()`

export const readFrameJs = (textOffset = 0): string =>
  call(
    `window.__cove.read(${MAX_ELEMENTS}, ${Math.max(0, Math.floor(textOffset))}, ${TEXT_WINDOW})`
  )

export interface Target {
  index?: number
  text?: string
}

export const locateJs = (target: Target): string =>
  call(`window.__cove.locate(${JSON.stringify(target)})`)

export const selectJs = (target: Target, options: string[]): string =>
  call(`window.__cove.select(${JSON.stringify(target)}, ${JSON.stringify(options)})`)

export const fileInputJs = (pick: { index?: number; input?: number }): string =>
  call(`window.__cove.fileInput(${JSON.stringify(pick)})`)

/** The element `fileInputJs` settled on, as an object a CDP call can take. */
export const UPLOAD_TARGET_JS = 'window.__cove && window.__cove.upload'

export const scrollJs = (opts: Target & { direction?: string; pages?: number }): string =>
  call(`window.__cove.scroll(${JSON.stringify(opts)})`)

export const frameCornerJs = (url: string, name: string, nth: number, reveal: boolean): string =>
  call(
    `window.__cove.frameCorner(${JSON.stringify(url)}, ${JSON.stringify(name)}, ${nth}, ${reveal})`
  )
