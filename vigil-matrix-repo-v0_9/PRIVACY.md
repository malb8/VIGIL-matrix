# Privacy

**Short version: VIGIL Matrix has no backend. Nothing you do with it leaves
your machine.**

## What the extension processes

| Data | Purpose | Where it lives |
| --- | --- | --- |
| Your policy (matrix cells, switches, settings) | Compiling DNR rules | `chrome.storage.local`, on your device |
| Draft (unsaved) policy edits and temporary trust | Live previews | `chrome.storage.session` (RAM-backed, cleared on browser exit) |
| Observed-domain history: which resource hosts were seen on which sites | Keeping blocked domains visible/unblockable in the matrix | `chrome.storage.local`, capped (200 sites, 80 targets/site, 30-day TTL) |
| Page scan of the active tab (resource URLs by host/type) | Building the matrix rows when you open the popup | Processed in memory; aggregated host/type counts persist as history above |
| Rule snapshots and matched-rule metadata | The "matched rules" viewer | `chrome.storage.session` |

## What the extension does NOT do

- No network requests to any server operated by this project. There is no
  such server.
- No telemetry, analytics, crash reporting, or usage statistics.
- No remote code, remote configuration, or remotely fetched blocklists. The
  bundled blocklist ships inside the extension package; updating it means
  updating the extension.
- No reading of page *content*. The scanner collects resource URLs (hosts and
  types), not page text, form data, or credentials.
- No scanning in the background. The page scanner runs only when you open the
  popup/side panel, only on the active tab.
- No sale, sharing, or transmission of any data to anyone, because the data
  never leaves `chrome.storage` on your device.

## Data removal

- Remove individual policies from the popup or the "My rules" editor.
- Remove everything by uninstalling the extension; Chromium deletes the
  extension's storage with it.
- Exported JSON/text policy files are created only when you click Export and
  are saved wherever you choose.

## Sync

VIGIL uses `chrome.storage.local`, not `chrome.storage.sync`. Your policy is
not uploaded to your browser vendor's sync service by this extension.

## Changes

Any future feature that changes the above (for example an optional list
updater) will be opt-in, documented here first, and reflected in the store
listing if a store release exists.
