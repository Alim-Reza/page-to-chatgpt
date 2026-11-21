const MAX_PAGE_CHARS_API = 100000; // keep API requests within model context limits
const MAX_PAGE_CHARS_WEB = 40000;  // chatgpt.com (esp. logged out) rejects very long messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ask") {
    handleAsk(msg.tabId, msg.message)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async response
  }
});

async function handleAsk(tabId, message) {
  const { apiKey, model, mode = "web" } = await chrome.storage.local.get(["apiKey", "model", "mode"]);

  const [{ result: pageText }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.getElementById("__page2gpt_panel")?.remove(); // don't send our own panel
      return document.body ? document.body.innerText : "";
    },
  });

  const limit = mode === "web" ? MAX_PAGE_CHARS_WEB : MAX_PAGE_CHARS_API;
  const prompt = buildPrompt(message, pageText || "", limit);

  await render(tabId, "loading", mode === "web" ? "Opening chatgpt.com…" : "Asking ChatGPT…");

  try {
    const reply = mode === "web"
      ? await askViaWebsite(prompt, (state, text) => render(tabId, state, text).catch(() => {}))
      : await askViaApi(apiKey, model || "gpt-4o-mini", prompt);
    await render(tabId, "done", reply);
  } catch (e) {
    await render(tabId, "error", e.message);
    throw e;
  }
}

function buildPrompt(message, pageText, limit) {
  const text = pageText.length > limit
    ? pageText.slice(0, limit) + "\n\n[...page text truncated...]"
    : pageText;
  return `${message || "Summarize this page."}\n\n--- PAGE TEXT ---\n${text}`;
}

/* ---------------- Mode 1: OpenAI API ---------------- */

async function askViaApi(apiKey, model, prompt) {
  if (!apiKey) throw new Error("No API key set (Settings → OpenAI API key).");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant. The user will give you the text of a web page and a request about it." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content || "(empty response)";
}

/* ---------------- Mode 2: chatgpt.com in a hidden tab (or window) ---------------- */

async function askViaWebsite(prompt, onProgress) {
  const { openIn = "tab" } = await chrome.storage.local.get("openIn");
  const target = await openChatGPT(openIn);
  const tabId = target.tabId;

  // Live updates from the ChatGPT page: status lines and the partial reply.
  let partial = "";
  const onMsg = (msg, sender) => {
    if (sender.tab?.id !== tabId || msg.type !== "gpt-progress") return;
    if (msg.reply) { partial = msg.text; onProgress("streaming", msg.text); }
    else onProgress("loading", msg.text);
  };
  chrome.runtime.onMessage.addListener(onMsg);

  // Resolves if the user closes the ChatGPT tab/window.
  let onRemoved;
  const closed = new Promise((resolve) => {
    onRemoved = (id) => { if (id === tabId) resolve({ closed: true }); };
    chrome.tabs.onRemoved.addListener(onRemoved);
  });

  try {
    const run = (async () => {
      onProgress("loading", "Waiting for ChatGPT to load…");
      await target.loaded;
      await inject(tabId, cgInstall);
      let r = await inject(tabId, cgPrepare);
      if (!r?.ok) return r;
      onProgress("loading", "Entering your prompt into ChatGPT…");
      r = await inject(tabId, cgEnter, [prompt]);
      if (!r?.ok) return r;
      r = await inject(tabId, cgSend);
      if (!r?.ok) return r;
      onProgress("loading", "Sent. Waiting for ChatGPT to reply…");
      return await inject(tabId, cgWaitForReply);
    })().catch((e) => ({ ok: false, error: e.message }));

    const result = await Promise.race([run, closed]);
    const stillOpen = await chrome.tabs.get(tabId).then(() => true, () => false);
    if (result.closed || !stillOpen) {
      if (partial) return partial;
      throw new Error("The ChatGPT tab/window was closed before a reply arrived.");
    }
    if (result?.ok) {
      target.close().catch(() => {});
      return result.text;
    }
    // Leave it open on failure so you can see what went wrong (captcha, login wall, etc.)
    if (partial) return partial + "\n\n[" + (result?.error || "stopped early") + "]";
    throw new Error((result?.error || "Unknown error") + ` (the ChatGPT ${openIn} was left open so you can check it)`);
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }
}

async function inject(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// Opens chatgpt.com without stealing your view. visibility-shim.js is registered only while our
// tab loads, so the page keeps working even though it's hidden (see that file for why).
const SHIM_ID = "p2g-visibility-shim";
async function openChatGPT(openIn) {
  const url = "https://chatgpt.com/";
  await chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: SHIM_ID, matches: ["https://chatgpt.com/*"], js: ["visibility-shim.js"],
    runAt: "document_start", world: "MAIN", persistAcrossSessions: false,
  }]);

  let tabId, close;
  try {
    if (openIn === "window") {
      const cur = await chrome.windows.getLastFocused().catch(() => null);
      const opts = { url, type: "popup", focused: false, width: 520, height: 720 };
      if (cur) {
        opts.left = Math.max(0, cur.left + cur.width - opts.width - 20);
        opts.top = Math.max(0, cur.top + cur.height - opts.height - 20);
      }
      const win = await chrome.windows.create(opts);
      if (cur) chrome.windows.update(cur.id, { focused: true }).catch(() => {}); // keep your window on top
      tabId = win.tabs[0].id;
      close = () => chrome.windows.remove(win.id);
    } else {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      close = () => chrome.tabs.remove(tab.id);
    }
  } catch (e) {
    await chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] }).catch(() => {});
    throw e;
  }

  const loaded = waitForTabComplete(tabId).finally(() =>
    chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] }).catch(() => {}));
  return { tabId, close, loaded };
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("chatgpt.com took too long to load")); }, timeout);
    const listener = (id, info) => { if (id === tabId && info.status === "complete") { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") { cleanup(); resolve(); } });
  });
}

/* ----- Functions below run INSIDE the chatgpt.com page (each must be self-contained). -----
   cgInstall puts shared helpers on window.__p2g; the extension's isolated world persists
   between injections, so the other functions can use them.
   If ChatGPT changes its page, SELECTORS is what you'll need to update. */

function cgInstall() {
  const S = {
    input: ['textarea[name="prompt"]', "#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', "textarea"],
    send: ['button[aria-label="Send message"]', 'button[data-testid="send-button"]', "button#composer-submit-button",
           'button[aria-label="Send prompt"]'],
    stop: ['button[aria-label="Stop generating"]', 'button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]'],
    user: 'li[data-message-role="user"], [data-message-author-role="user"]',
    assistant: 'li[data-message-role="assistant"], [data-message-author-role="assistant"]',
    replyText: ["[data-assistant-markdown-root]", ".markdown"],
  };
  const g = { S };
  g.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  g.first = (list, root = document) => {
    for (const s of list) {
      const els = [...root.querySelectorAll(s)];
      const el = els.find(visible) || els[0];
      if (el) return el;
    }
    return null;
  };
  g.count = (sel) => document.querySelectorAll(sel).length;
  g.waitFor = async (fn, timeout, what) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await g.sleep(300); }
    throw new Error("Timed out waiting for " + what);
  };
  g.tryWait = (fn, timeout) => g.waitFor(fn, timeout, "").catch(() => null);
  g.dismissPopups = () => {
    for (const el of document.querySelectorAll("a, button")) if (/stay logged out/i.test(el.textContent)) el.click();
  };
  g.report = (text, reply = false) => { try { chrome.runtime.sendMessage({ type: "gpt-progress", text, reply }); } catch {} };
  g.input = () => g.first(S.input);
  g.sendButton = () => { const b = g.first(S.send); return b && !b.disabled ? b : null; };
  g.inputText = () => { const i = g.input(); return i ? (i.tagName === "TEXTAREA" ? i.value : i.innerText) : ""; };
  g.snapshot = () => { g.before = { users: g.count(S.user), assistants: g.count(S.assistant) }; };
  g.sent = () => g.count(S.user) > g.before.users || g.count(S.assistant) > g.before.assistants || !!g.first(S.stop);
  window.__p2g = g;
  return true;
}

async function cgPrepare() {
  const g = window.__p2g;
  try {
    g.dismissPopups();
    if (/\/auth\/login/.test(location.pathname)) throw new Error("ChatGPT is asking you to log in");
    await g.waitFor(g.input, 30000, "the ChatGPT input box (maybe a login wall or captcha?)");
    await g.sleep(1000); // let the composer finish hydrating
    g.dismissPopups();
    g.snapshot();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function cgEnter(prompt) {
  const g = window.__p2g;
  const input = g.input();
  if (!input) return { ok: false, error: "ChatGPT input box disappeared" };
  const has = () => g.inputText().trim().length > 0;
  input.focus();
  if (input.tagName !== "TEXTAREA") {
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  document.execCommand("insertText", false, prompt); // behaves like typing
  if (await g.tryWait(has, 1500)) return { ok: true };

  if (input.tagName === "TEXTAREA") {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, prompt);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const dt = new DataTransfer();
    dt.setData("text/plain", prompt);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  if (await g.tryWait(has, 2000)) return { ok: true };
  return { ok: false, error: "Couldn't put the text into ChatGPT's input box" };
}

async function cgSend() {
  const g = window.__p2g;
  await g.sleep(300);
  const btn = await g.tryWait(g.sendButton, 8000);
  if (btn) btn.click();
  if (await g.tryWait(g.sent, 5000)) return { ok: true };
  const input = g.input();
  input?.focus();
  input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  if (await g.tryWait(g.sent, 3000)) return { ok: true };
  input?.closest("form")?.requestSubmit?.();
  if (await g.tryWait(g.sent, 3000)) return { ok: true };
  return { ok: false, error: `Couldn't send the message (send button ${btn ? "clicked" : "not found"})` };
}

async function cgWaitForReply() {
  const g = window.__p2g, S = g.S;
  const replyNode = () => {
    const a = document.querySelectorAll(S.assistant);
    return a.length > g.before.assistants ? a[a.length - 1] : null;
  };
  const replyText = () => {
    const n = replyNode();
    if (!n) return "";
    return (g.first(S.replyText, n) || n).innerText.trim();
  };
  const busy = () => replyNode()?.querySelector('[aria-busy="true"]') != null;
  try {
    await g.waitFor(() => { g.dismissPopups(); return replyText(); }, 90000, "ChatGPT to start replying");
    // Done = unchanged for 2s with no stop button and nothing busy, or unchanged for 8s regardless.
    let last = "", stableSince = Date.now();
    const end = Date.now() + 300000;
    while (Date.now() < end) {
      await g.sleep(500);
      g.dismissPopups();
      const text = replyText();
      const streaming = !!g.first(S.stop) || busy();
      const stableFor = Date.now() - stableSince;
      if (text !== last) { last = text; stableSince = Date.now(); g.report(text, true); }
      else if (text && ((!streaming && stableFor > 2000) || stableFor > 8000)) return { ok: true, text };
    }
    if (last) return { ok: true, text: last + "\n\n[timed out — response may be incomplete]" };
    return { ok: false, error: "Timed out waiting for ChatGPT's response" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- Render the answer at the bottom of the page ---------------- */

function render(tabId, state, text) {
  return chrome.scripting.executeScript({
    target: { tabId },
    args: [state, text],
    // Runs inside the page. Must be self-contained.
    func: (state, text) => {
      let host = document.getElementById("__page2gpt_panel");
      if (!host) {
        host = document.createElement("div");
        host.id = "__page2gpt_panel";
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `
          <style>
            .box { all: initial; display: block; font: 14px/1.5 system-ui, sans-serif; color: #111;
                   background: #f7f7f8; border-top: 3px solid #10a37f; padding: 16px 20px; margin-top: 24px; }
            .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
            .title { font-weight: 700; color: #10a37f; }
            button { font: inherit; cursor: pointer; border: 1px solid #ccc; background: #fff; border-radius: 4px; padding: 2px 8px; margin-left: 6px; }
            .body { white-space: pre-wrap; word-wrap: break-word; }
            .error { color: #b00020; }
            .loading { color: #666; font-style: italic; }
          </style>
          <div class="box">
            <div class="head">
              <span class="title"></span>
              <span><button id="copy">Copy</button><button id="close">Close</button></span>
            </div>
            <div class="body"></div>
          </div>`;
        shadow.getElementById("close").onclick = () => host.remove();
        shadow.getElementById("copy").onclick = () =>
          navigator.clipboard.writeText(shadow.querySelector(".body").textContent);
        document.body.appendChild(host);
        host.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      const body = host.shadowRoot.querySelector(".body");
      body.className = "body " + (state === "error" ? "error" : state === "loading" ? "loading" : "");
      body.textContent = state === "error" ? "Error: " + text : text;
      host.shadowRoot.querySelector(".title").textContent =
        state === "streaming" ? "ChatGPT response (writing…)" : "ChatGPT response";
      if (state === "done" || state === "error") host.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });
}
