# Link Rescue link-check Worker (Cloudflare, free)

This small Cloudflare Worker loads each external link on Cloudflare's servers and returns its real status to Link Rescue: `200` working, `404` not found, and so on. It works for every site, including ones like bit.ly that hide the status from the browser.

- **Cost:** free, with no credit card. The Workers free plan allows 100,000 requests a day (reset at midnight UTC); only links the browser can't check are sent, and the panel remembers each answer for a day. If the limit is ever reached, those links simply can't be checked until the next day: nothing is charged.
- **Privacy:** it only receives the link address. It doesn't store pages or keep logs of its own.
- **Safety:** it returns only a status code (never page content), and it refuses private or internal addresses. It answers any page, because Experience Workspace loads extensions from its own addresses.

## Set it up (about 10 minutes, in the browser)

1. Go to **https://dash.cloudflare.com/sign-up** and create a free account, or sign in.
2. In the left menu, open **Compute (Workers)** → **Workers & Pages**, then click **Create** → **Create Worker**.
3. Name it **`link-rescue`** and click **Deploy**. This deploys a "Hello World" starter.
4. Click **Edit code**. Delete everything in the editor, paste the whole contents of [`link-check.js`](link-check.js), and click **Deploy**.
5. Copy the Worker's address shown at the top, e.g. `https://link-rescue.<your-subdomain>.workers.dev`.
   Opening that address should show `{"ok":true,"service":"link-rescue-check"}`.

## Connect it to Link Rescue

Add `?checker=<Worker address>` to the Link Rescue row in the site's **library** sheet (`https://da.live/config#/{org}/{site}/`):

```
https://main--link-rescue--shivanim123.aem.live/tools/link-rescue/link-rescue.html?checker=https://link-rescue.<your-subdomain>.workers.dev
```

Reload Experience Workspace. Links the browser can't check are then sent to your Worker. (This site's Worker is already built into `tools/link-rescue/lib/linkcheck.js` as the default.)

No key or password is needed anywhere: the Worker address is the only setting.
