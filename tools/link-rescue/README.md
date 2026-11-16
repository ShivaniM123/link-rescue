# Link Rescue – Experience Workspace extension

**Find and fix broken links before you publish, with one-click Wayback Machine rescue.**

Link Rescue is a side panel for Experience Workspace (da.live). It checks every link on the page you're editing while you write. It explains each problem in plain language and fixes it in one click.

| | |
|---|---|
| Third parties | [Internet Archive – Wayback Machine](https://archive.org/help/wayback_api.php) (Availability API, free, no key): archived copies of dead pages |
| | [Microlink](https://microlink.io/) (free plan, no key): confirms the status of pages whose sites hide it from the browser, such as bit.ly |
| Demo | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html?demo` |

## Why authors need it

A broken link is one of the most common mistakes on a published page, and nothing in the editor warns about it. Links break when:

- a page on the site is renamed, deleted or never published,
- an author pastes an editor link (`da.live/edit#…`) or a preview link (`aem.page`) instead of the real page,
- an external site moves a page or shuts down,
- an old link still uses the retired `hlx.page` / `hlx.live` domains.

## What to check

| Scope | What's checked |
|---|---|
| **This page** | The page open in Experience Workspace, as soon as the panel opens and again as you edit |
| **Folder** | Every page in the open page's folder and its sub-folders (shown when the page is inside a folder) |
| **All pages** | Every page on the site, including nav and footer (up to 500 pages) |

In folder and site scans, each link is listed once with the pages it's on. A fix is applied on every one of those pages. Before Link Rescue changes more than the open page, it asks you to confirm.

## What it checks

| Finding | How it's detected | One-click fix |
|---|---|---|
| **Missing page** on this site | Site publishing status + page source | Closest existing page, or remove the link and keep the text |
| **Not published / draft only** | Page is only in preview or only in the editor | Opens that page so you can publish it |
| **Editor link** (`da.live/edit#…`) | Address pattern | The page itself (`/path`) |
| **Preview link** (`*.aem.page`) | Address pattern | Relative link that works on preview and live |
| **Old domain** (`hlx.page` / `hlx.live`) | Address pattern | Same address on `aem.page` / `aem.live` |
| **Local address** (`localhost`) | Address pattern | Relative link |
| **Broken** external page (404 / 410) | Browser request, or Microlink for sites that hide status from the browser (e.g. bit.ly) | **Archived copy from the Wayback Machine**, or remove the link |
| **Not confirmed** | The status couldn't be confirmed (e.g. the day's free Microlink checks are used up) | Listed under Needs attention so the author opens it once |
| **Unreachable / timed out** external site | Browser request fails | **Archived copy from the Wayback Machine** |
| **Moved** external page | Browser request follows the redirect | The new address |
| **Not secure** (`http://`) | Address + checks the `https://` version | Switch to `https://` |

Every external link also shows whether the Wayback Machine has a backup. If it doesn't, the author can **save one now**.

The verdict at the top says whether the page is safe to publish. **Apply suggested fixes** applies every fix that keeps readers on the same content in one go. It never guesses a different page. Each fix can be undone.

## How fixes are applied

1. If the open page is affected, Link Rescue asks the editor to save it first.
2. For each affected page, it reads the saved page and changes only the matching `<a href>` values. If the link text shows the old address, the text is updated too.
3. It writes each page back with the author's own sign-in. Document Authoring pushes the change into any open editor straight away.

Nothing is previewed or published by Link Rescue.

## Install

1. The extension is in this repo at `tools/link-rescue/`. Merging to `main` makes it available at
   `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html`.
2. Open `https://da.live/config#/shivanim123/link-rescue/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Link Rescue | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html` | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/icon.svg` | `inline` |

   If the site has no config or no `library` sheet yet, add it with the **+** button next to the sheet tabs. `inline` opens the extension as a side panel next to the page.
3. Save the config, reload Experience Workspace, open any page and choose **Extensions → Link Rescue**.

Options (add them to the path as query parameters):

- `hosts=www.example.com,example.com`: production domains that count as this site.
- `demo`: always show the demo page.

## Limits and next steps

- Browsers only show the status of a page on another site if that site allows it (CORS). For other sites, Link Rescue asks Microlink. Its free plan allows only about 5 checks a day per person, so only those links are sent, and each answer is remembered for a day. When the checks run out, those links show as "Not confirmed". For bigger sites, a Microlink PRO key or your own link-check service (for example a Cloudflare Worker) removes the limit. It plugs into `lib/linkcheck.js`.
- Possible next steps: images as well as links, and a scheduled site-wide report.

## Files

```
tools/link-rescue/
  link-rescue.html   panel page
  link-rescue.js     panel: editor connection, checks, fixes, rendering
  link-rescue.css    styles (light and dark)
  lib/links.js       finds links and works out their type
  lib/checks.js      checks each link and suggests fixes
  lib/wayback.js     Wayback Machine integration
  lib/linkcheck.js   Microlink integration
  lib/fixes.js       applies a fix to the page HTML
  lib/site.js        lists and reads pages for folder and site scans
  demo/sample.html   demo page with one example of each problem
  demo/about.html    second demo page, for folder and site scans
```
