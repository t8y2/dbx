# Website Worker setup

## Contributor certificate OAuth

The contributors page treats an account as eligible only when it has authored at least one pull request merged into `t8y2/dbx`. Commit counts are displayed as an additional metric but do not grant eligibility by themselves.

Create a GitHub OAuth App with:

- Homepage URL: `https://dbxio.com`
- Authorization callback URL: `https://dbxio.com/api/auth/github/callback`

Configure the deployed Cloudflare Worker secrets from `docs/`:

```bash
pnpm dlx wrangler secret put GITHUB_CLIENT_ID
pnpm dlx wrangler secret put GITHUB_CLIENT_SECRET
pnpm dlx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` should be a randomly generated value of at least 32 bytes. The OAuth flow requests no repository scopes, reads the authenticated user's public GitHub identity, and discards the access token immediately afterward.

For a non-production callback origin, also configure `GITHUB_OAUTH_CALLBACK_URL` as a Worker secret matching the callback registered in the OAuth App.

## Anonymous Issue submission

The `/issue` and `/issues` routes redirect to the localized anonymous feedback page. Creating a draft consumes one allowance from both a per-IP and a temporary-session rolling limit of 8 attempts per hour. Final submission does not consume another allowance. Cloudflare Turnstile is intentionally not used.

Create a GitHub App installed only on `t8y2/dbx` with repository permission `Issues: Read and write`, then configure:

```bash
pnpm dlx wrangler secret put GITHUB_APP_ID
pnpm dlx wrangler secret put GITHUB_APP_PRIVATE_KEY_B64
pnpm dlx wrangler secret put ISSUE_RATE_LIMIT_SECRET
```

`GITHUB_APP_PRIVATE_KEY_B64` accepts the base64-encoded PEM downloaded from the GitHub App. Generate a single-line value with `base64 < private-key.pem | tr -d '\n'`. `ISSUE_RATE_LIMIT_SECRET` should be an independent random value of at least 32 bytes. `SESSION_SECRET` is used as a fallback only to avoid breaking an already deployed Worker.

Configure an OpenAI-compatible multimodal chat-completions provider:

```bash
pnpm dlx wrangler secret put ISSUE_AI_API_BASE
pnpm dlx wrangler secret put ISSUE_AI_API_KEY
pnpm dlx wrangler secret put ISSUE_AI_MODEL
```

`ISSUE_AI_API_BASE` may end at the host, `/v1`, or `/chat/completions`. The model must accept `image_url` data URLs when screenshots are attached.

`docs/wrangler.json` binds `ISSUE_IMAGES` to the existing `dbx` R2 bucket and publishes generated image URLs under `https://dl.dbxio.com` by default. Set `ISSUE_IMAGE_PUBLIC_BASE_URL` if the bucket's public origin changes. Set `ISSUE_GITHUB_REPOSITORY` only when testing against a different repository; production defaults to `t8y2/dbx`.
