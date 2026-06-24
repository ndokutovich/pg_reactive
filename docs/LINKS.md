# pgStack — every entry point

One index of all live URLs and published artifacts. (Infra/deploy map: [DEPLOYMENTS.md](./DEPLOYMENTS.md).)

## Sites

| What | URL |
|------|-----|
| **Landing** (marketing) | https://pgstack.org/ |
| **Docs** (Docusaurus) | https://reactive.pgstack.org/docs/ · https://pgstack.org/docs/ |
| **Studio** (admin SPA) | https://pgstack.org/studio/ · https://reactive.pgstack.org/studio/ |
| **Examples gallery** | https://reactive.pgstack.org/ · https://pgstack.org/examples/ |

## Live examples (pg_reactive)

Served at two paths — `reactive.pgstack.org/<slug>/app.html` (root) and
`pgstack.org/examples/<slug>/app.html` (apex). Same backend.

| # | Example | reactive.pgstack.org |
|---|---------|----------------------|
| 01 | Live Product Catalog | https://reactive.pgstack.org/01-live-products/app.html |
| 02 | Order Feed | https://reactive.pgstack.org/02-order-feed/app.html |
| 03 | Revenue Dashboard | https://reactive.pgstack.org/03-revenue-dashboard/app.html |
| 04 | Category Leaderboard | https://reactive.pgstack.org/04-category-leaderboard/app.html |
| 05 | Realtime CRM | https://reactive.pgstack.org/05-realtime-crm/app.html |
| 06 | Inventory Monitor | https://reactive.pgstack.org/06-inventory-monitor/app.html |
| 07 | Multi-Filter | https://reactive.pgstack.org/07-multi-filter/app.html |
| 08 | Order Analytics | https://reactive.pgstack.org/08-order-analytics/app.html |
| 09 | Price Comparison | https://reactive.pgstack.org/09-price-comparison/app.html |
| 10 | Executive Scorecard | https://reactive.pgstack.org/10-executive-scorecard/app.html |
| 11 | Notify Mode | https://reactive.pgstack.org/11-notify-mode/app.html |
| 12 | Tutorial | https://reactive.pgstack.org/12-tutorial/app.html |

## Full-stack demo apps

| App | URL |
|-----|-----|
| **Todo** | https://reactive.pgstack.org/apps/todo/ · https://pgstack.org/examples/apps/todo/ |
| **Expenses** | https://reactive.pgstack.org/apps/expenses/ · https://pgstack.org/examples/apps/expenses/ |
| **What to Buy** (shopping) | https://shop.pgstack.org/ |
| **Polyglot Matching Engines** (6 languages, one schema) | https://polyglot.pgstack.org/ |

## Published packages

| Package | Install | Registry |
|---------|---------|----------|
| `@pgstack/sdk` | `npm i @pgstack/sdk` | https://www.npmjs.com/package/@pgstack/sdk |
| `pgstack` (CLI) | `npx pgstack init` | https://www.npmjs.com/package/pgstack |

## Published Docker images (Docker Hub, public)

| Image | Pull |
|-------|------|
| Go proxy | `docker pull pgstack/pgstack-proxy` |
| Rust proxy | `docker pull pgstack/pgstack-proxy-rust` |
| PostgreSQL + pg_reactive | `docker pull pgstack/pgstack-postgres` |
| **All-in-one** (quickstart) | `docker run pgstack/pgstack-all-in-one` |

Also on GHCR: `ghcr.io/ndokutovich/pgstack-{proxy,proxy-rust,postgres,all-in-one}` (private).

## Source

| What | URL |
|------|-----|
| Repository | https://github.com/ndokutovich/pg_reactive |
| Releases | https://github.com/ndokutovich/pg_reactive/releases |
