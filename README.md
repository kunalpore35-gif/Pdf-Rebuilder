# BLINK PDF Modifier — Cloudflare + MEGA 20 GB edition

This project keeps the BLINK server-side PDF workflow but removes Cloudflare R2 completely. Storage is handled by a MEGA account through `megajs` 1.3.x. `megajs` is an unofficial JavaScript MEGA SDK; its browser build uses fetch-style HTTP and client-side encryption. MEGA's official SDK documentation confirms that MEGA uses client-controlled encryption for stored files and transfers.

## Architecture

Phone → Cloudflare Pages → Cloudflare Worker → Cloudflare Queue → MEGA → final PDF

The browser never generates the final PDF. The completed PDF is uploaded to MEGA once. `/api/download/:jobId` streams that existing file; it does not run the processor again.

## MEGA setup

Create/use the MEGA account that will hold the BLINK files. The Worker needs these encrypted secrets:

- `MEGA_EMAIL`
- `MEGA_PASSWORD`
- `GEMINI_API_KEY`
- `API_AUTH_SECRET` (recommended)

The application creates a top-level folder named `BLINK-PDF-Modifier` (configurable with `MEGA_ROOT_FOLDER`). Inside it, job data is organised as:

`jobs/<jobId>/input/...`
`jobs/<jobId>/checkpoint/...`
`jobs/<jobId>/chunks/...`
`jobs/<jobId>/preview/...`
`jobs/<jobId>/output/result.pdf`

## Install

```bash
npm install
```

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill the secrets, then:

```bash
npm run dev
```

## Deploy Worker

Create the Queue `blink-pdf-jobs`, then deploy:

```bash
npx wrangler deploy
npx wrangler secret put MEGA_EMAIL
npx wrangler secret put MEGA_PASSWORD
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put API_AUTH_SECRET
```

Do not put MEGA credentials in `public/config.js`.

## Pages

Deploy `public/` as the Pages static output. Set `WORKER_API_BASE` in `public/config.js` to the Worker URL. If `API_AUTH_SECRET` is enabled, set the same token in the frontend configuration only if the Pages site is private/admin-only; for a public site, put authentication in front of the API instead of exposing a bearer secret to every visitor.

## Limits

Default configuration:

- 20 PDFs/batch
- 1000 total source pages
- 500 MB/file
- 20 pages/chunk
- queue concurrency 2

These are environment variables in `wrangler.toml`.

## Important MEGA storage note

MEGA is not an S3/R2-compatible object store. Therefore this version uses MEGA folders/files rather than R2 object keys. Metadata and checkpoints are JSON files, and binary PDFs/previews are normal MEGA files. The adapter also uses MEGA's encrypted upload/download path rather than treating MEGA as a raw HTTP bucket.

The MEGA JavaScript SDK is unofficial, so pinning the dependency version is intentional. Before production use, test the Worker against your own MEGA account and review MEGA's current Terms of Service.
