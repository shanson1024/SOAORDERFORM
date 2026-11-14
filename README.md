# Swaggeroo CRM

A CRM for a promotional products business: leads, a six-stage deal pipeline
(New Lead → Qualified → Quote Sent → Proof → Production → Delivered), a calendar
of in-hand dates, analytics, and a public order form that feeds new leads in.

## What is in this repo

| Path | What it is |
|---|---|
| `server.js` | The server: logins, leads and deals API, order form intake, optional AI drafting |
| `Swaggeroo_CRM.html` | The CRM screen. Served at `/` after sign-in |
| `public/order.html` | The customer order form, served at `/order` with no login |
| `public/login.html` | Sign-in page |
| `public/adapter.js` | Connects the CRM screen to the server API |
| `test/api.test.js` | Server tests |
| `Swaggeroo_Order_Form.jsx` | The older email-based order form (React component) |

Data is stored in a SQLite file at `DATA_DIR/swaggeroo.db`.

## Run it locally

Requires Node 20 or newer.

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='ten-or-more-chars' npm start
```

Open http://localhost:3000 and sign in. The order form is at http://localhost:3000/order.

Run the tests with `npm test`.

## Settings

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates the admin account on first start. Changing `ADMIN_PASSWORD` later resets that account's password on the next restart. Password must be 10+ characters. Add more people in Settings → Team |
| `DATA_DIR` | Folder for the database file. Must be on a disk that survives restarts |
| `PORT` | Port to listen on (default 3000) |
| `NODE_ENV=production` | Marks the login cookie Secure. Set this whenever the site is served over HTTPS |
| `ANTHROPIC_API_KEY` | Optional. Enables "Draft follow-up email" and "Summarize my pipeline" |

## Deploy on Railway

`railway.json` tells Railway to build the Dockerfile and health-check `/api/health`.

1. In Railway: New Project → Deploy from GitHub repo → pick this repo and the branch to deploy.
2. On the service, open Variables and add `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10+ characters). Add `ANTHROPIC_API_KEY` if you want the AI features.
3. Right-click the service → Attach Volume, with mount path `/data`. Do this before adding real records.
4. Settings → Networking → Generate Domain (or add a custom domain such as `crm.swaggeroo.com`).
5. Open the domain, sign in, and send customers to `/order`.

The deploy log prints a warning if no volume is attached.

## Deploy anywhere else

Any host that runs a Docker container or a Node process with a persistent disk works.

```bash
docker build -t swaggeroo-crm .
docker run -p 3000:3000 -v swaggeroo-data:/data \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='ten-or-more-chars' \
  swaggeroo-crm
```

Three things to get right on a host:

1. Mount a persistent disk at `/data`. Without one, records are lost on every redeploy.
2. Serve over HTTPS (most hosts do this for you) and keep `NODE_ENV=production`.
3. Back up `/data/swaggeroo.db` on a schedule.

## How order requests arrive

A customer fills in `/order`. The server validates the request, totals the
quantities, and saves it as a lead with source "Order form". It shows up in the
CRM within 20 seconds for anyone signed in. The form is rate-limited per visitor
and has a hidden field that filters out basic bots.
