# Link Rescue

**Find and fix broken links before you publish, on one page, a folder or any pages you choose, with one-click Wayback Machine rescue.**

Link Rescue is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing and checks every link on it. It can also scan a whole folder, or any pages you pick from the site. Each problem is explained in plain language and fixed in one click.

| | |
|---|---|
| Third parties | [Internet Archive – Wayback Machine](https://archive.org/help/wayback_api.php) (Availability API, free, no key): archived copies of dead pages |
| | [Cloudflare Workers](worker/README.md) (free plan): a small link-check service that confirms the real status of pages on sites that hide it from the browser, such as bit.ly |
| Panel | https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html |
| Demo | https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html?demo |

## Why authors need it

A broken link is one of the most common mistakes on a published page, and nothing in the editor warns about it. Links break when:

- a page on the site is renamed, deleted or never published,
- an author pastes an editor link (`da.live/edit#…`) or a preview link (`aem.page`) instead of the real page,
- an external site moves a page or shuts down, or a short link (bit.ly) stops working,
- an old link still uses the retired `hlx.page` / `hlx.live` domains.

Link Rescue catches all of these **before** the page goes live, and fixes them without leaving the editor.

## Features

### 1. Choose what to check

| Scope | What's checked |
|---|---|
| **This page** (default) | The page open in Experience Workspace. Checked as soon as the panel opens. |
| **Folder** | Every page in the open page's folder and its sub-folders. Shown when the page is inside a folder. |
| **Select pages** | The pages you choose from a list of the site's pages (up to 500 listed, including nav and footer). Search the list, tick pages, use **Select all / Clear**, then **Check N pages**. The open page is ticked to start with, and **Change pages** reopens the list with your selection kept. |

In folder and selected-page scans:
- each link is listed once, with the pages it's on (for example "On 2 pages: /, /nav"),
- each page opens in the editor with one click,
- a fix is applied on every page that has the link.

### 2. Links to your own site

| Finding | What it means | Fix offered |
|---|---|---|
| **Missing page** | There's no page at that address. Readers get "page not found". | The closest existing page (e.g. `/indx` → `/`) |
| **Not published** | The page is only in preview. It works for you but not for readers. | A link to open that page so you can publish it |
| **Draft only** | The page exists in the editor but hasn't been previewed or published. | A link to open that page |
| **Redirects** | The page forwards to another one. | Link straight to the final page |

### 3. Common author mistakes

| Finding | What it means | Fix offered |
|---|---|---|
| **Editor link** | A `da.live/edit#…` link. Readers can't sign in to the editor. | The real page (`/path`) |
| **Preview link** | An `*.aem.page` link that sends readers to the preview site. | A relative link that works on preview and live |
| **Old domain** | A retired `hlx.page` / `hlx.live` address. | The same address on `aem.page` / `aem.live` |
| **Local address** | A `localhost` link copied from someone's own computer. | The page on the site |
| **Empty or invalid link** | A link with no address, or an address that isn't a URL. | Flagged so you can edit it |

### 4. Links to other websites

| Finding | What it means | Fix offered |
|---|---|---|
| **Broken** | The page is gone (404 / 410), including broken short links such as bit.ly. | **The archived copy from the Wayback Machine** or **the site's home page** |
| **Unreachable** | The site can't be reached. The domain may have shut down. | **The archived copy from the Wayback Machine** |
| **Timed out** | The site took too long to answer. | The archived copy from the Wayback Machine |
| **Moved** | The page now redirects to a new address. | The new address |
| **Not secure** | An `http://` link. Link Rescue checks whether the `https://` version works. | Switch to `https://` |
| **Server error** | The site answered with a 5xx error. It may be down for now. | The archived copy from the Wayback Machine |
| **Refused** | The site refused the request (e.g. 401 / 403, it needs a login). | Flagged for review |

Email (`mailto:`), phone (`tel:`) and jump links (`#…`) are listed but not checked.

### 5. Wayback Machine rescue
- **"Use the archived copy from [date]"** for dead external pages, so readers still get the content.
- Every external link shows whether a backup exists ("Archived 5 Sep 2017 · View copy").
- Links that already point to a Wayback Machine copy are recognised as safe.

### 6. Link check on Cloudflare
- Some sites, such as bit.ly and many company sites, don't let a browser see whether a page exists. So every external link is checked by the site's Cloudflare Worker, which loads it on Cloudflare's servers and returns the real status. That's how a broken bit.ly link shows as **Broken**.
- It also reports where moved pages now lead, and which sites can't be reached.
- Each answer is remembered for a day, and **Check again** always asks fresh. The free plan allows about 100,000 checks a day.
- If a link can't be checked (for example on a network or with a browser extension that blocks `workers.dev`), it's listed under **Broken links** with a **Not checked** badge and the exact reason, so you can open it once to make sure it works. The summary also says how many couldn't be checked.

### 7. Fixing
- **Suggested replacement links** for broken external links, each checked before it's offered and shown next to its button:
  - **Use the archived copy:** from the Wayback Machine.
  - **Use the site's home page:** when the page is gone but the site still works (not offered for short-link services like bit.ly).
- **One-click fix** on every problem, with **Undo**. Undo also works for fixes that changed several pages.
- **Apply N suggested fixes** applies every safe fix in one go. Safe fixes keep readers on the same content: old domains, editor and preview links, moved pages, `https://` and archived copies. It never guesses a different page for you.
- **Confirm before changing other pages:** before a fix changes more than the open page, the panel shows "This changes links on N pages in Document Authoring. Nothing is published."
- **Update link** (the blue button on every card) opens a small form, like the editor's link dialog, with **Address** and **Link text** already filled in. Save changes the link on every page it's on (with the same confirmation and Undo as other fixes). Invalid addresses are rejected, and links with bold text or images inside keep their formatting.
- When no working replacement exists, the card says so: "No working replacement found. Update the link with an address you know works."
- Link text that shows the old address is updated too.
- Only the matching links change. The rest of each page stays exactly as it was.
- Link Rescue never previews or publishes anything.

### 8. Panel experience
- **Summary card** at the top with an icon and a one-line verdict, for example "4 broken links: fix them before you publish" or "All links look good: safe to publish". Folder and selected-page scans add "across N pages".
- **Stat tiles** for Broken and Working links. Click **Working** to list the working links (link text, address and what was found, e.g. Live or Working) below the broken ones; click again to hide them.
- **Apply N safe fixes** button right under the summary.
- **One Broken links list.** Each card's badge says exactly what was found: Not found, Gone, Unreachable, Timed out, Missing page, Not published, Editor link, Preview link, Old domain, Moved, Not secure, Server error, or Not checked (with the reason). The most serious problems come first, then links on the most pages, and fixed links drop off the list straight away.
- **Compact cards:** link text, a problem badge, the address (opens in a new tab), one short sentence on what's wrong, and the fix buttons.
- **Loading skeleton** and a progress bar while scanning ("Finding pages… / Reading pages 12 of 40 / Checking links 30 of 85").
- **"Nothing to fix"** state when every link works.
- **Checks only run when you ask:** when the panel opens, the first time you open Folder, when you click **Check N pages** in Select pages, and when you click **Check again** (the round button in the header). Fixes and Undo don't re-check anything: a fixed link just drops off the list. If you add, remove or change links in the editor, the panel shows "The page's links changed since the last check" with a **Check again** button, instead of re-checking on its own.
- Fixes are turned off when you can view a page but not edit it.
- If the panel can't connect to the editor, it says so ("Couldn't connect to the editor") instead of showing the wrong page.
- Light and dark mode, reduced motion, keyboard focus styles and screen-reader labels.
- **Demo mode** (`?demo`), with two sample pages that cover every problem type, so folder and selected-page scans can be shown without a real site.

## How it works

| Check | Source |
|---|---|
| Pages on your site | The site's publishing status (`admin.hlx.page`) and the page source (`admin.da.live`) |
| Folder scans and the page list | The Document Authoring page list (`admin.da.live/list`) |
| External links | The **Cloudflare Worker** loads each link and returns its real status (200, 404, …). The browser is only used if the Worker can't be reached. |
| Archived copies | **Wayback Machine** Availability API |

When you click a fix:
1. If the open page is affected, Link Rescue asks the editor to save it first.
2. It reads each affected page and changes only the matching `<a href>` values.
3. It writes each page back with your own sign-in. Document Authoring then pushes the change into any open editor straight away.

## Install

1. Merge to `main`. The panel is then available at
   `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html`.
2. Open `https://da.live/config#/shivanim123/link-rescue/`, go to the **library** sheet and add a row:

   | title | path | icon | experience |
   |---|---|---|---|
   | Link Rescue | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html` | `https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/icon.svg` | `inline` |

   If the site has no config or no `library` sheet yet, add it with the **+** button next to the sheet tabs. `inline` opens the extension as a side panel next to the page.
3. Save the config, reload Experience Workspace, open any page and choose **Extensions → Link Rescue**.

**Testing a branch:** add a second row with the branch address, e.g. `https://aem-20261116-1245--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html`, titled **Link Rescue (branch)**.

Options (add them to the panel address as query parameters):

- `hosts=www.example.com,example.com`: production domains that count as this site.
- `checker=…`: Link Rescue uses this site's link-check Worker (`https://link-rescue.shanukakhani.workers.dev`, set in `tools/link-rescue/lib/linkcheck.js`). Use `checker=<another Worker address>` to use a different one (see [worker/README.md](worker/README.md)).
- `demo`: always show the demo pages.

## Limits and next steps

- **Link checks on Cloudflare's free plan:** about 100,000 a day, so even full scans fit easily. See [`worker/`](worker/README.md) to set up a Worker for another site.
- **Site scans** cover up to 500 pages.
- **Possible next steps:** check images as well as links, and send a scheduled site-wide report.

## Project structure

This repo only hosts the extension. The Edge Delivery boilerplate site code (blocks, scripts, styles) has been removed.

```
tools/link-rescue/
  link-rescue.html   panel page
  link-rescue.js     panel: editor connection, scopes, fixes, rendering
  link-rescue.css    styles (light and dark)
  icon.svg           panel icon
  lib/links.js       finds links and works out their type
  lib/checks.js      checks each link and suggests fixes
  lib/site.js        lists and reads pages for folder scans and Select pages
  lib/fixes.js       applies a fix to the page HTML
  lib/wayback.js     Wayback Machine integration
  lib/linkcheck.js   Cloudflare Worker link check
  demo/sample.html   demo page with one example of each problem
  demo/about.html    second demo page, for folder scans and Select pages
worker/
  link-check.js      optional Cloudflare Worker for link checks (not served by the site)
  README.md          how to set it up in the Cloudflare dashboard
```

## Development

```sh
npm i
npm run lint
```

Run `aem up` and open `http://localhost:3000/tools/link-rescue/link-rescue.html?demo`.
