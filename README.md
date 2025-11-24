# Country Revealer 4X

A lightweight Chrome extension that shows the country of any X profile directly inside the timeline, replies, and
profile views. It reads the public About Account data from X, interprets it, caches it locally, and displays a small
flag next to each username. Everything works entirely in the browser with zero external servers.

## Features

- Adds a country flag next to every visible username on X.
- Detects About Account data through the official X web requests.
- Shows a white shield icon if a VPN or proxy is likely.
- Shows a circled number if the user changed usernames in the past in case it >2.
- Includes a smart cache to avoid repeating the same request.
- Handles rate limits from X and uses a safety cooldown.
- All data is stored locally in chrome.storage.local.
- Privacy-friendly. No analytics, no tracking, no remote servers.

## How It Works

### Background service worker

- Listens to outgoing X requests to learn:
    - Bearer token required for GraphQL calls.
    - Query ID used by the official client for About Account lookups.
    - ct0 cookie for CSRF checks.
- Maintains a request queue with automatic rate limit protection.
- Stores fetched country results in the local browser database.
- Exposes a small API to the content script through chrome messages.

### Content script

- Uses a MutationObserver to watch for new elements in the timeline.
- Extracts usernames and asks the background for their country.
- Injects the flag next to display names.
- Adds a hover tooltip with all parsed details.

### Popup

- Shows:
    - Queue length
    - Fetch counters
    - Cache size
    - Top 5 countries by frequency
- Includes a one click option to clear the local database.

## File Structure

```text
extension-root/
  README.md
  PRIVACY.md
  LICENSE.md
  manifest.json
  background.js
  content.js
  content.css
  popup.html
  popup.css
  popup.js
  utils.js
  resources/
    icons16.png
    icons32.png
    icons48.png
    icons128.png
```

## Installation for Development

1. Clone the repository.
2. Open Chrome, go to [chrome://extensions](chrome://extensions).
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select the folder that contains `manifest.json`.

The extension should appear immediately and start working on x.com.

## Debugging

The solution provides possibility to enable verbose logging of every action, via setting `DEBUG` variable in both files
to `true`:

* `utils.js`
* `background.js`

## Building for Release

1. Make sure `DEBUG` is set to `false` in all scripts.
2. Update the version in manifest.json.
3. Zip the extension folder with `manifest.json` at the root.
4. Upload or publish to the Chrome Web Store.

## Privacy

This extension:

- Does not send data to any external server.
- Uses only the official X API through the logged in browser session.
- Stores all results locally on the device.
- Allows users to fully clear the database at any moment.

Read [PRIVACY.md](PRIVACY.md) for more details.

## Disclaimer

This project is independent and not affiliated with X Corp or Twitter.
All data shown is derived from the public About Account information that X exposes to logged-in users.

## LICENSE

MIT License

Copyright (c) 2025 antidotcb
