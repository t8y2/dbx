# Contributor certificate OAuth setup

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
