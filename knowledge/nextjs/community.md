# Next.js — Community Knowledge

> **This file is maintained by contributors.** Add patterns, gotchas, and best practices
> that the official docs don't cover well. PRs welcome.
>
> Last updated: 2026-09-14

## Security Checklist

- [ ] `poweredByHeader: false` in next.config — prevents leaking `X-Powered-By: Next.js`
- [ ] `reactStrictMode: true` — catches common React bugs in development
- [ ] No secrets in `NEXT_PUBLIC_` env vars — these are embedded in the client bundle
- [ ] `.env.local` in `.gitignore` — never commit local env files
- [ ] Middleware/proxy protects authenticated routes — check for auth logic in `middleware.ts` or `proxy.ts`
- [ ] Server actions validate auth before mutations — `'use server'` functions are reachable via direct POST
- [ ] `serverActions.allowedOrigins` set in next.config — prevents CSRF on server actions
- [ ] CSP headers configured via `headers()` in next.config or middleware
- [ ] API routes validate request origin/auth — Route Handlers (`route.ts`) have no built-in protection

## Common Gotchas

### `route.ts` and `page.tsx` can't coexist
A folder with both `route.ts` and `page.tsx` is invalid. The route handler wins and the page is ignored. This causes silent failures.

### Server Components are the default
In the App Router, all components are Server Components unless you add `'use client'` at the top. This means:
- No `useState`, `useEffect`, or browser APIs without `'use client'`
- `onClick` and other event handlers need `'use client'`
- Server Components can `await` directly and access databases

### `error.tsx` must be a Client Component
The `error.tsx` boundary requires `'use client'` at the top. Without it, you get a build error. Same for `global-error.tsx`.

### Dynamic segments in parallel routes
If you use `@slot` parallel routes, every slot needs a `default.tsx` fallback. Missing this causes 404s during soft navigation when the slot has no matching content.

### Middleware runs on every request
Middleware executes on ALL routes by default. Always use the `matcher` config to scope it, or you'll add latency to static assets. Common matcher pattern:
```
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
}
```

### `fetch()` caching changed in Next.js 15
Before v15: `fetch()` was cached by default (`force-cache`).
After v15: `fetch()` is NOT cached by default (`no-store`).
This is a breaking change when upgrading — pages that were fast via caching become slow.

### `generateStaticParams` doesn't mean fully static
A page with `generateStaticParams` is pre-rendered at build time for the listed params, but new params at runtime still work (they're rendered on-demand unless `dynamicParams = false`).

## File Organization Patterns

### Route groups for auth boundaries
```
app/
├── (public)/          ← no auth required
│   ├── page.tsx       ← landing page
│   └── about/
├── (authenticated)/   ← middleware protects these
│   ├── dashboard/
│   └── settings/
└── (auth)/            ← login/signup flows
    ├── login/
    └── signup/
```

### Colocating related files
Since only `page.tsx` and `route.ts` create routes, you can put components, tests, and styles right next to them:
```
app/dashboard/
├── page.tsx           ← the route
├── dashboard-chart.tsx ← not routable, just a component
├── actions.ts         ← server actions
└── dashboard.test.ts  ← tests
```

### Server actions in separate files
Keep `'use server'` in dedicated action files rather than inline. This makes auth checks consistent and actions reusable:
```
app/dashboard/
├── page.tsx
└── actions.ts         ← 'use server' at top, all exports are server actions
```

## Performance Patterns

### Use `loading.tsx` for instant navigation
Every route segment can have a `loading.tsx`. This shows immediately during navigation while the page's data loads, making the app feel fast.

### Parallel data fetching in Server Components
Don't `await` sequentially — use `Promise.all`:
```tsx
// Bad: sequential (slow)
const user = await getUser()
const posts = await getPosts()

// Good: parallel (fast)
const [user, posts] = await Promise.all([getUser(), getPosts()])
```

### Route segment config for caching
```tsx
// Force static generation (fail build if dynamic)
export const dynamic = 'error'

// ISR: revalidate every 60 seconds
export const revalidate = 60

// Force dynamic (no caching)
export const dynamic = 'force-dynamic'
```
