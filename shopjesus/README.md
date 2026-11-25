# ShopJesus.com

Full-stack store for ShopJesus.com: t-shirts, hoodies, hats, polos and button-down shirts.

- **Storefront**: home, shop with category filter and sorting, product pages with color/size options, cart.
- **Checkout**: Stripe Checkout (cards, Apple Pay, Google Pay). Card details never touch this server.
- **Admin** (`/admin`): dashboard, orders (mark shipped, tracking, cancel/refund status), products, photos, inventory.
- **Stack**: Node.js, Express, EJS templates, SQLite. No build step.

## Run locally

```bash
cd shopjesus
npm install
ADMIN_PASSWORD=choose-one npm start
```

Open http://localhost:3000. Without Stripe keys, checkout runs in a clearly labelled test mode that takes
no payment. Test mode is disabled when `NODE_ENV=production`.

## Go live

1. **Host it** on any Node host with a persistent disk (Railway, Render, Fly, a VPS). On Railway: create a
   service from this repo, set the root directory to `shopjesus`, attach a volume mounted at `/data`.
2. **Set the variables** listed in `.env.example` (`NODE_ENV`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `BASE_URL`,
   `DATA_DIR=/data`, Stripe keys).
3. **Stripe**: copy your secret key into `STRIPE_SECRET_KEY`. Add a webhook endpoint for
   `https://shopjesus.com/webhooks/stripe` with the event `checkout.session.completed`
   (and `checkout.session.async_payment_succeeded`), then copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Domain**: point shopjesus.com at the host.
5. **Sales tax**: enable Stripe Tax in Stripe, then set `STRIPE_TAX=true`.
6. **Emails** (optional): set `SMTP_URL` to send order-confirmation and shipped emails.

## Managing the store

- Log in at `/admin` with `ADMIN_PASSWORD`.
- **Products**: add or edit name, price, description, photo, colors, sizes and stock. The products that ship
  with the site are placeholders with drawn mock-ups; replace them with your own items and photos.
- **Orders**: paid orders show under "to ship". Marking one shipped emails the customer the tracking number.
- **Refunds**: issue the refund in the Stripe dashboard, then mark the order refunded here to restock.

## Data and backups

Everything lives in `DATA_DIR`: `shop.db` (products, orders) and `uploads/` (photos). Back up that folder.
