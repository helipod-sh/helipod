---
title: Authentication
---

# Authentication

> Auth works the same as Convex - configure providers in auth.config.ts.

Stackbase supports the same authentication system as Convex. Configure your auth providers in `convex/auth.config.ts` and use `ctx.auth.getUserIdentity()` in your functions.

## Configuration

```ts
// convex/auth.config.ts
export default {
  providers: [
    {
      domain: "https://your-app.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};
```

## Convex documentation

For complete auth documentation, see:

- [Authentication](https://docs.convex.dev/auth) - Overview and concepts
- [Clerk](https://docs.convex.dev/auth/clerk) - Clerk integration
- [Auth0](https://docs.convex.dev/auth/auth0) - Auth0 integration
- [Custom JWT](https://docs.convex.dev/auth/advanced/custom-auth) - Custom auth providers

## Stackbase-specific notes

### Convex Auth vs third-party providers

**Convex Auth** (Convex's first-party authentication system) is not currently supported in Stackbase. This is because Convex Auth is tightly integrated with Convex Cloud's infrastructure.

**Use third-party providers instead:**

| Provider | Status | Notes |
|----------|--------|-------|
| Clerk | Supported | Recommended for most apps |
| Auth0 | Supported | Enterprise features |
| Custom OIDC | Supported | Any OIDC-compliant provider |
| Firebase Auth | Supported | Via custom JWT configuration |
| Convex Auth | Not supported | Requires Convex Cloud |

### Runtime compatibility

Token verification works identically across all Stackbase runtimes:

| Runtime | Token Validation | JWKS Fetch | Notes |
|---------|------------------|------------|-------|
| Cloudflare Workers | Yes | Yes | Uses `fetch` for JWKS |
| Bun | Yes | Yes | Uses native `fetch` |
| Node.js | Yes | Yes | Uses native `fetch` (Node 18+) |

### How token verification works

1. Client sends JWT in `Authorization` header
2. Stackbase extracts the `iss` (issuer) claim
3. Fetches JWKS from `{issuer}/.well-known/jwks.json`
4. Validates signature, expiration, and audience
5. Makes identity available via `ctx.auth.getUserIdentity()`

### Environment variables

For self-hosted deployments, ensure your auth provider's domain is accessible from your server. No special environment variables are required beyond your provider's configuration.

## Common questions

- **Are there any auth differences from Convex?** Token validation works the same way. The only difference is Convex Auth (first-party) is not supported.
- **Can I use Convex Auth?** No, Convex Auth requires Convex Cloud. Use Clerk, Auth0, or another third-party provider.
- **Will Convex Auth be supported?** It's not currently on the roadmap, as third-party providers offer equivalent functionality.
- **Can I migrate from Convex Auth?** You'll need to migrate users to a third-party provider before switching to Stackbase.

---

