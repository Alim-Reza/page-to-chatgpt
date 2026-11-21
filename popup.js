const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["apiKey", "model", "mode", "openIn", "lastMessage"], (s) => {
  $("mode").value = s.mode || "web";
  $("openIn").value = s.openIn || "tab";
  $("apiKey").value = s.apiKey || "";
  $("model").value = s.model || "gpt-4o-mini";
  $("message").value = s.lastMessage || "";
});

$("mode").addEventListener("change", () => chrome.storage.local.set({ mode: $("mode").value }));
$("openIn").addEventListener("change", () => chrome.storage.local.set({ openIn: $("openIn").value }));
$("apiKey").addEventListener("change", () => chrome.storage.local.set({ apiKey: $("apiKey").value.trim() }));
$("model").addEventListener("change", () => chrome.storage.local.set({ model: $("model").value.trim() }));

$("send").addEventListener("click", async () => {
  const mode = $("mode").value;
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || "gpt-4o-mini";
  const message = $("message").value.trim();

  if (mode === "api" && !apiKey) {
    $("settings").open = true;
    $("status").textContent = "API mode needs an OpenAI API key.";
    return;
  }

  await chrome.storage.local.set({ mode, openIn: $("openIn").value, apiKey, model, lastMessage: message });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("send").disabled = true;
  $("status").textContent = "Sending… the reply will appear at the bottom of the page.";

  // Background worker does the work so it continues even if the popup closes.
  chrome.runtime.sendMessage({ type: "ask", tabId: tab.id, message }, (res) => {
    $("send").disabled = false;
    if (chrome.runtime.lastError) {
      $("status").textContent = "Error: " + chrome.runtime.lastError.message;
    } else if (res && res.error) {
      $("status").textContent = "Error: " + res.error;
    } else {
      $("status").textContent = "Done.";
    }
  });
});
