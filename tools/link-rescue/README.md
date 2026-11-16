# Link Rescue – Experience Workspace extension

**Find and fix broken links before you publish, on one page, a folder or the whole site, with one-click Wayback Machine rescue.**

Link Rescue is an Experience Workspace (da.live) extension. It opens as a side panel next to the page you're editing and checks every link on it as you write. It can also scan a whole folder or the whole site. Each problem is explained in plain language and fixed in one click.

| | |
|---|---|
| Third parties | [Internet Archive – Wayback Machine](https://archive.org/help/wayback_api.php) (Availability API, free, no key): archived copies of dead pages |
| | [Microlink](https://microlink.io/) (free plan, no key): confirms the real status of pages on sites that hide it from the browser, such as bit.ly |
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
| **This page** (default) | The page open in Experience Workspace. Checked as soon as the panel opens, and again whenever you pause typing. |
| **Folder** | Every page in the open page's folder and its sub-folders. Shown when the page is inside a folder. |
| **All pages** | Every page on the site, including nav and footer (up to 500 pages). |

In folder and site scans:
- each link is listed once, with the pages it's on (for example "On 2 pages: /, /nav"),
- each page opens in the editor with one click,
- a fix is applied on every page that has the link.

### 2. Links to your own site

| Finding | What it means | Fix offered |
|---|---|---|
| **Missing page** | There's no page at that address. Readers get "page not found". | The closest existing page (e.g. `/indx` → `/`), or remove the link and keep the text |
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
| **Empty or invalid link** | A link with no address, or an address that isn't a URL. | Remove the link, keep the text |

### 4. Links to other websites

| Finding | What it means | Fix offered |
|---|---|---|
| **Broken** | The page is gone (404 / 410), including broken short links such as bit.ly. | **The archived copy from the Wayback Machine**, or remove the link |
| **Unreachable** | The site can't be reached. The domain may have shut down. | **The archived copy from the Wayback Machine**, or remove the link |
| **Timed out** | The site took too long to answer. | The archived copy from the Wayback Machine |
| **Moved** | The page now redirects to a new address. | The new address |
| **Not secure** | An `http://` link. Link Rescue checks whether the `https://` version works. | Switch to `https://` |
| **Server error** | The site answered with a 5xx error. It may be down for now. | The archived copy from the Wayback Machine |
| **Refused** | The site refused the request (e.g. 401 / 403, it needs a login). | Flagged for review |
| **Not confirmed** | The page's status couldn't be confirmed, for example once the day's free Microlink checks are used up. | Listed under **Links to fix** so you open it once. It's never shown as working. |

Email (`mailto:`), phone (`tel:`) and jump links (`#…`) are listed but not checked.

### 5. Wayback Machine rescue
- **"Use the archived copy from [date]"** for dead external pages, so readers still get the content.
- Every external link shows whether a backup exists ("Archived 5 Sep 2017 · View copy").
- Links that already point to a Wayback Machine copy are recognised as safe.

### 6. Microlink status check
- Some sites, such as bit.ly and many company sites, don't let a browser see whether a page exists. For those links, Microlink loads the page on its servers and returns the real status. That's how a broken bit.ly link shows as **Broken**.
- It also reports where moved pages now lead, and which sites can't be reached.
- Only links the browser can't confirm are sent to Microlink, and each answer is remembered for a day. That makes the free plan go further.
- When the day's free checks are used up, the panel says so, and those links show as **Not confirmed** until the next day.

### 7. Fixing
- **One-click fix** on every problem, with **Undo**. Undo also works for fixes that changed several pages.
- **Apply N suggested fixes** applies every safe fix in one go. Safe fixes keep readers on the same content: old domains, editor and preview links, moved pages, `https://` and archived copies. It never guesses a different page for you.
- **Confirm before changing other pages:** before a fix changes more than the open page, the panel shows "This changes links on N pages in Document Authoring. Nothing is published."
- **Remove the link, keep the text** for links that can't be saved.
- Link text that shows the old address is updated too.
- Only the matching links change. The rest of each page stays exactly as it was.
- Link Rescue never previews or publishes anything.

### 8. Panel experience
- **Summary card** at the top with an icon and a one-line verdict, for example "4 broken links: fix them before you publish", "No broken links: 2 links could be better" or "All links look good: safe to publish". Folder and site scans add "across N pages".
- **Stat tiles** for Broken, Outdated and Working links.
- **Apply N safe fixes** button right under the summary.
- **Grouped list:** **Broken** (readers hit a dead end), **Outdated** (works for now, but should be updated) and **Not confirmed** (open these once to check them). Links on the most pages come first, and fixed links drop off the list straight away.
- **Compact cards:** link text, a problem badge, the address (opens in a new tab), one short sentence on what's wrong, and the fix buttons.
- **Loading skeleton** and a progress bar while scanning ("Finding pages… / Reading pages 12 of 40 / Checking links 30 of 85").
- **"Nothing to fix"** state when every link works.
- A round **Check again** button in the header, next to the page being checked.
- Fixes are turned off when you can view a page but not edit it.
- If the panel can't connect to the editor, it says so ("Couldn't connect to the editor") instead of showing the wrong page.
- Light and dark mode, reduced motion, keyboard focus styles and screen-reader labels.
- **Demo mode** (`?demo`), with two sample pages that cover every problem type, so folder and site scans can be shown without a real site.

## How it works

| Check | Source |
|---|---|
| Pages on your site | The site's publishing status (`admin.hlx.page`) and the page source (`admin.da.live`) |
| Folder and site scans | The Document Authoring page list (`admin.da.live/list`) |
| External links | A browser request reads the status when the site allows it. Otherwise **Microlink** loads the page and returns the real status. |
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
- `demo`: always show the demo pages.

## Limits and next steps

- **Microlink free plan:** about 5 checks a day per person. That's enough for a page, not for a full site scan. A Microlink PRO key, or a small link-check service of your own (for example a Cloudflare Worker), removes the limit. Either plugs into `tools/link-rescue/lib/linkcheck.js`.
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
  lib/site.js        lists and reads pages for folder and site scans
  lib/fixes.js       applies a fix to the page HTML
  lib/wayback.js     Wayback Machine integration
  lib/linkcheck.js   Microlink integration
  demo/sample.html   demo page with one example of each problem
  demo/about.html    second demo page, for folder and site scans
```

## Development

```sh
npm i
npm run lint
```

Run `aem up` and open `http://localhost:3000/tools/link-rescue/link-rescue.html?demo`.
