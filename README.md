# Link Rescue

**Find and fix broken links before you publish, with one-click Wayback Machine rescue.**

Link Rescue is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing and checks every link on that page while you write. It explains each problem in plain language and fixes it in one click.

| | |
|---|---|
| Third party | [Internet Archive – Wayback Machine](https://archive.org/help/wayback_api.php) (Availability API, free, no key) |
| Panel | https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html |
| Demo | https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html?demo |

## Why authors need it

A broken link is one of the most common mistakes on a published page, and nothing in the editor warns about it. Links break when a page is renamed, deleted or never published. They also break when an author pastes an editor or preview link, an external site moves or shuts down, or an old link still uses the retired `hlx` domains. Link Rescue catches all of these **before** the page goes live.

## Features

### Links to your own site
- **Missing page:** suggests the closest matching page (e.g. `/indx` → `/`), or removes the link and keeps the text.
- **Not published:** the page is only in preview, so readers would get "page not found". Links you to that page so you can publish it.
- **Draft only:** the page exists in the editor but hasn't been previewed or published.
- **Redirects:** suggests linking straight to the final page.

### Common author mistakes
- **Editor link** (`da.live/edit#…`): readers can't open these. Replaced with the real page.
- **Preview link** (`*.aem.page`): sends readers to the preview site. Replaced with a link that works on preview and live.
- **Old domain** (`hlx.page` / `hlx.live`): switched to `aem.page` / `aem.live`.
- **Local address** (`localhost`): replaced with the page on the site.

### Links to other websites
- **Broken** (404 / 410), **unreachable** or **timed out**: offers the archived copy from the Wayback Machine.
- **Moved:** suggests the new address.
- **Not secure** (`http://`): checks the `https://` version and offers to switch.
- **Server error:** flags sites that are answering with an error.

### Wayback Machine rescue
- **"Use the archived copy from [date]"** for dead external pages, so readers still get the content.
- Every external link shows whether a backup exists, with a link to view it.
- **"Save one now"** when no backup exists, so the page is archived before it disappears.

### Fixing
- **One-click fix** on every problem, with **Undo**.
- **Apply all suggested fixes** applies every safe fix in one go. Safe fixes keep readers on the same content. It never guesses a different page.
- **Remove the link, keep the text** for links that can't be saved.
- Link text that shows the old address is updated too.
- Only the matching links change. The rest of the page stays exactly as it was.
- Nothing is previewed or published by Link Rescue.

### Panel experience
- **Publish verdict** at the top: "4 broken links: fix before you publish" or "All links look good. Safe to publish".
- Checks again as you edit, after a short pause in typing.
- **Needs attention / All / Fixed** tabs.
- Repeated links are grouped and show how many times they're used.
- Fixes are turned off when you can view the page but not edit it.
- Light and dark mode.
- **Demo mode** with a sample page containing one example of each problem.

## How it works

| Check | Source |
|---|---|
| Pages on your site | The site's publishing status (`admin.hlx.page`) and page source (`admin.da.live`) |
| External links | A browser request. It reads the status when the site allows it, and otherwise checks whether the site answers |
| Archived copies | Wayback Machine Availability API |

When you click a fix, Link Rescue saves the editor and reads the saved page. It changes the matching `<a href>` values and writes the page back with your own sign-in. Document Authoring then pushes the change into the open editor.

## Install

1. Merge to `main`. The panel is then available at
   `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html`.
2. Open `https://da.live/config#/shivanim123/link-rescue/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Link Rescue | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html` | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/icon.svg` | panel |

3. Open any page in Experience Workspace and open **Link Rescue**.

Options (add them to the panel address as query parameters):

- `hosts=www.example.com,example.com`: production domains that count as this site.
- `demo`: always show the demo page.

## Limits and next steps

- Some websites don't let a browser check their pages (CORS). For those sites, Link Rescue can still tell whether the site is up, but it can't confirm a 404, so the link shows as "Site responds". A small link-check service (for example a Cloudflare Worker) would remove this limit. It would plug into `probe()` in `tools/link-rescue/lib/checks.js`.
- Possible next steps: check every page on the site, images as well as links, and a scheduled report.

## Project structure

This repo only hosts the extension. The Edge Delivery boilerplate site code (blocks, scripts, styles) has been removed.

```
tools/link-rescue/
  link-rescue.html   panel page
  link-rescue.js     panel: editor connection, checks, fixes, rendering
  link-rescue.css    styles (light and dark)
  icon.svg           panel icon
  lib/links.js       finds links and works out their type
  lib/checks.js      checks each link and suggests fixes
  lib/wayback.js     Wayback Machine integration
  lib/fixes.js       applies a fix to the page HTML
  demo/sample.html   demo page with one example of each problem
```

## Development

```sh
npm i
npm run lint
```

Run `aem up` and open `http://localhost:3000/tools/link-rescue/link-rescue.html?demo`.
