# O — Outstanding (What I Need From You — 3 clear steps)

## Step 1 — Fix frontend access (urgent — 2 min)
**What you saw:** `{"error":"ADMIN_API_KEY not configured in production"}` then after fix `302 -> cloudflareaccess.com`
**Why:** Two auth layers — `src/index.ts:54` (Worker) + Cloudflare Access (Edge). Layer 1 fixed today, layer 2 still blocks API.
**Do now:**
1. Open panel in browser: `https://opran-booking.maakebda.workers.dev/` — will ask for Access login (OTP) first, then the Worker Basic dialog (username: anything, password: `ADMIN_API_KEY`) → sets `__Host-opran_admin_token` session cookie and loads `GET /api/status`.

## Step 2 — Choose API security model 

* Create Service Token: `Zero Trust -> Access -> Service Tokens -> Create` -> add `Service Auth` policy on app `opran-booking.maakebda.workers.dev` **scoped to path `/api/*` only** (not `/`). Then frontend calls with: `CF-Access-Client-Id` + `CF-Access-Client-Secret` + `X-API-Key`.
> Save the `ADMIN_API_KEY` generated today and delete temp file `shred -u /tmp/admin_key.txt`.

## Step 3
1. **Telegram (later phase):** Create bot via @BotFather, get `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` when we reach that phase.
2. **Passport 6-month rule:** Officially correct or needs verification? (currently [ASSUMPTION])
3. **Account:** Confirm `maakebda@gmail.com` is intended for infra (replaced `abdalsamed71@gmail.com` token on device).

---
