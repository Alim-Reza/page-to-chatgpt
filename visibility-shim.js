// Injected at document_start into the page's own JS world, only into the chatgpt.com tab this
// extension opens (background.js registers it just for the moment that tab is loading).
//
// Why: Chrome treats background tabs as hidden and pauses requestAnimationFrame there. The current
// chatgpt.com UI waits on those before its input box starts working, so a prompt typed into a
// hidden tab is ignored until you look at the tab. This makes the page believe it is visible
// and focused, and keeps animation-frame callbacks running.
(() => {
  if (window.__p2gShim) return;
  window.__p2gShim = true;

  Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
  Object.defineProperty(Document.prototype, "webkitVisibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(Document.prototype, "webkitHidden", { get: () => false, configurable: true });
  Document.prototype.hasFocus = () => true;
  document.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
  window.addEventListener("blur", (e) => e.stopImmediatePropagation(), true);

  // requestAnimationFrame never fires in a hidden tab; fall back to a timer when it doesn't.
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let nextId = 0;
  window.requestAnimationFrame = (cb) => {
    const id = ++nextId;
    const run = (ts) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      realCAF(p.raf);
      clearTimeout(p.timer);
      cb(typeof ts === "number" ? ts : performance.now());
    };
    pending.set(id, { raf: realRAF(run), timer: setTimeout(() => run(performance.now()), 50) });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const p = pending.get(id);
    if (p) { realCAF(p.raf); clearTimeout(p.timer); pending.delete(id); }
  };
})();
