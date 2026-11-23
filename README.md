# CubiX

The website, the client portal and the team dashboard all run on Cloudflare Pages (free plan): pages in `public/`, backend in `functions/`, data in D1, files in R2.

## What is included
- **Website** (`/`): portfolio, pricing, specs, FAQ and the free order form.
- **Client portal** (`/app/`): shop owners sign up or get a login link, place orders with photos, follow progress, see previews, approve or ask for changes, download print ready files and message the team. Every shop sees only its own orders.
- **Team dashboard** (`/team/`): one screen for the whole team.
  - Overview: open orders, due in 24 hours, overdue, unassigned, awaiting payment, paid this month, and a "Needs attention" list.
  - Capacity: total team load against capacity, plus each modeler's load.
  - Board: drag orders through New, Confirmed, Modeling, Preview sent, Revisions, Approved and Delivered.
  - Order panel: assign, set priority and due time, send previews, deliver final files, chat with the shop or leave internal notes, set price and payment, see full history.
  - Orders list with search and filters, Shops (plans, notes, login links), Team (invite people, roles, capacity, deactivate).
- **API** (`functions/api/[[route]].js`, helpers in `functions/_lib/core.js`): accounts, sessions, roles and permissions, orders, files, messages, history.

### Roles
- **Admin:** everything, including prices, payments, shop plans and team members.
- **Modeler:** sees all orders, claims orders for themselves, moves status, uploads previews and final files, and messages shops. Cannot change prices, payments or the team.
- **Client:** their own shop's orders only. Internal notes and assignments are never shown to them.

### How an order moves
1. **New:** a shop orders through the website form or the portal. The first order from each shop is free, and it is due in 48 hours (24 for rush).
2. **Confirmed:** a modeler claims the order.
3. **Modeling.**
4. **Preview sent:** the shop is notified.
5. The shop approves (**Approved**), or asks for changes (**Revisions**, due again within 24 hours, then back to step 4).
6. **Delivered:** final files are uploaded.
7. **Paid:** the admin marks it paid. Payment can be recorded once the shop approves. If the order is already paid, uploading the final files closes it straight away.

### Security
- Passwords are hashed with PBKDF2 (100,000 rounds).
- Sessions use an HttpOnly cookie, and only a hash of the session token is stored.
- Login links work once and expire.
- Login locks for 15 minutes after 8 failed attempts.
- Every request that changes data must carry the `x-cubix` header, which blocks cross site request forgery.
- Every file download is checked against the order's shop.

## One time setup (about 15 minutes)
You need a free Cloudflare account and Node.js installed.

```bash
npm install
npx wrangler login
npx wrangler d1 create scalehaus
```
Paste the `database_id` that command prints into `wrangler.toml`. Then:

```bash
npm run db:remote
npx wrangler r2 bucket create scalehaus-orders
npm run deploy
```

In the Cloudflare dashboard (Workers & Pages, scalehaus, Settings, Variables and Secrets):
- `BOOTSTRAP_KEY` (required once): any long random text. It is used to create the first admin.
- `SITE_URL`: your domain, for example `https://cubix3d.com`. It is used in emailed links.
- `RESEND_API_KEY` and `MAIL_FROM` (optional): a free [Resend](https://resend.com) account sends invites, password resets and "preview ready" emails. Without these, the dashboard shows each link so you can send it yourself.
- `ORDER_WEBHOOK` (optional): a Slack, Discord or Google Chat webhook. It posts a message for every new order, message, approval and revision.

### Create the first admin
Run this once, with your own details:

```bash
curl -X POST https://YOUR-DOMAIN/api/auth/bootstrap -H "content-type: application/json" -d '{"key":"YOUR_BOOTSTRAP_KEY","name":"Rizwan","email":"you@example.com","password":"a strong password"}'
```

Then sign in at `/team/`. Add your modelers under Team: each one gets a link to set a password.

### Shops
- Shops that order through the website form get an account automatically. Open them under Shops and click "Login link" to give them portal access.
- Shops can also sign up themselves at `/app/`.

## Preview and test locally
```bash
npm install
./tests/fresh.sh
```
This starts a fresh local database and the server on http://localhost:8788, with the bootstrap key `local-bootstrap-key` taken from `.dev.vars`. Then run:

```bash
npm run test:api
```
That runs 129 checks on accounts, permissions, the order lifecycle, files, payments and capacity. For the full browser test (104 checks, desktop and phone, screenshots in `tests/shots/`), first run `./tests/fresh.sh` again, then:

```bash
npm run test:e2e
```

## Editing
The site is built from `src/` into `public/`. After any change in `src/`, run:

```bash
python3 build.py
```

- **Pages:** `src/pages/*.html`. Each page starts with a meta line for its title and description.
- **Header, footer, menu, popups:** `src/partials/`.
- **Styles:** `public/assets/css/site.css` for the website, `public/assets/css/panel.css` for the portal and dashboard. All colours and fonts are set at the top.
- **Portal and dashboard:** `src/panel/` (page shells) and `public/assets/js/panel-core.js`, `team.js`, `app.js`.
- **Interactions, portfolio list and contact email:** `public/assets/js/site.js`. The `WORK` list holds the projects, and `CONFIG` holds the email address.
- **Portfolio images:** `public/assets/img/work/`. Each project has `NN-a.webp` to `NN-d.webp` (four views) and an optional `NN-photo.webp`.
- **3D models on the Specs page:** the `MODELS` list in `public/assets/js/viewer.js`. Files are in `public/assets/models/`.

## Site settings (no coding needed)
Open `public/assets/js/site.js` and scroll to the `window.CUBIX` block at the bottom:
- `holiday`: the deadline shown in the top bar. Change `cutoff` (YYYY-MM-DD) and `filesBy` each season. After the cutoff the bar switches back automatically.
- `testimonials`: add real quotes from shop owners. The "What shops say" section appears on the home page as soon as there is one entry.
- `prints`: add photos of finished prints (put the images in `public/assets/img/prints/`). The "Printed by our clients" section appears as soon as there is one entry.
- `analyticsToken`: paste your free Cloudflare Web Analytics token to start counting visitors.

Category illustrations in `public/assets/img/cats/` are renders made for the site. Replace them with real order photos or licensed stock photos whenever you have them.
