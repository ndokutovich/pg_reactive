# pg_reactive docs site

Docusaurus 3 site for the pgStack / pg_reactive documentation. Doc pages live in `docs/`, config in `docusaurus.config.ts` (sidebar in `sidebars.ts`; the blog is disabled via `blog: false`). `DOCS_URL` / `DOCS_BASE_URL` env vars override the site URL and base path at build time.

## Develop

```bash
npm install
npm start
```

## Build

```bash
npm run build   # static output in build/
```

## Deploy

The site is built into the proxy image (`proxy-go/Dockerfile`, `docs-builder` stage, served under `/docs/`) and shipped by `.github/workflows/deploy.yml` on pushes touching `docs/site/**`. There is no manual `yarn deploy` / gh-pages step.
