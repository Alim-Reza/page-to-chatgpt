# Page to ChatGPT

A Chrome extension that sends the text of the current page, plus your own message, to ChatGPT and shows the reply at the bottom of the page.

## Modes

- **ChatGPT website (default, no API key):** opens chatgpt.com in a hidden background tab, enters the prompt, waits for the reply to finish, then closes the tab. The reply streams into the current page as ChatGPT writes it.
- **OpenAI API:** calls the OpenAI Chat Completions API with your own API key. Set the key and model in the popup's Settings.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon, type a message (e.g. "Summarize this page"), and click **Send page to ChatGPT**.

## Notes

- Website mode depends on how chatgpt.com's page is built, so it breaks whenever OpenAI changes the page. The selectors to update are in `cgInstall()` in `background.js`.
- `visibility-shim.js` makes the hidden ChatGPT tab behave as if it were visible. Without it, chatgpt.com doesn't finish setting up in a background tab. It's registered only while the extension's own tab is loading.
- Website mode was tested with chatgpt.com logged out. It does not yet work when you're logged in to ChatGPT.
- Website mode automates the ChatGPT UI, which may go against OpenAI's terms of use. API mode is the supported route.
