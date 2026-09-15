# Next.js: Community Knowledge

> **This file is maintained by contributors.** Add patterns, gotchas, and best practices
> that the official docs don't cover well. PRs welcome.
>
> Last updated: 2026-09-15. Written against Next.js 16.3.5; notes call out where behavior
> differs in Next.js 15 or depends on Cache Components. For the official pages, start at
> `lens://knowledge/nextjs/docs/index.md`.

## Security Checklist

- [ ] No secrets in `NEXT_PUBLIC_` env vars. They are inlined into the client JavaScript at build time.
- [ ] `.env*.local` is in `.gitignore`. `.env`, `.env.development`, and `.env.production` can be committed only if they contain no secrets.
- [ ] Authentication and authorization are checked **inside every Server Action**. Actions your app uses are reachable by a direct POST with their action ID; unused actions are removed at build time.
- [ ] Authentication is checked **inside every Route Handler**. Route Handlers have no built-in protection, and relying only on a proxy matcher means one matcher change silently exposes routes.
- [ ] Webhook routes verify the provider's signature (Stripe, GitHub, Svix, …), and cron routes check a shared secret.
- [ ] `import 'server-only'` in modules that hold secrets or database access, so importing them from client code fails the build.
- [ ] `serverActions.allowedOrigins` is set **only** when Server Action requests arrive through another host, such as a reverse proxy. Next.js already rejects actions whose `Origin` host doesn't match the app's host; avoid wildcards.
- [ ] `poweredByHeader: false` in `next.config`, so responses don't advertise `X-Powered-By: Next.js`.
- [ ] Security headers (Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options) are set via `headers()` in `next.config` or in proxy. Check whether your host already adds HSTS.
- [ ] Pages Router only: `reactStrictMode: true`. The App Router has had Strict Mode on by default since Next.js 13.5.1.

## Next.js 16 changes that bite

### `middleware` is now `proxy`
`middleware.ts` is deprecated and renamed to `proxy.ts`, with the exported function renamed to `proxy`. Proxy always runs on the Node.js runtime, so apps that need the edge runtime should keep `middleware` for now. The upgrade codemod handles the rename:
```bash
npx @next/codemod@canary upgrade latest
```

### Request APIs are async only
The synchronous compatibility from Next.js 15 is gone. `cookies()`, `headers()`, `draftMode()`, `params` (in layouts, pages, route handlers, and `default.js`), and `searchParams` (in pages) must be awaited:
```bash
npx @next/codemod@canary next-async-request-api .
npx next typegen   # generates PageProps, LayoutProps, and RouteContext type helpers
```

### Every parallel route slot needs `default.js`
Builds fail when a slot has no `default.js`. To keep the previous behavior, add one that calls `notFound()` or returns `null`.

### `revalidateTag` takes a cache profile
`revalidateTag('posts')` becomes `revalidateTag('posts', 'max')`, which serves stale content while it revalidates. For read-your-writes inside a Server Action, use `updateTag` instead.

### Turbopack is the default bundler
`next dev` and `next build` use Turbopack. If `next.config` has a custom `webpack` option (sometimes added by a plugin), `next build` fails. Migrate it to Turbopack-compatible options, build with `--webpack` to keep Webpack, or build with `--turbopack` to ignore the `webpack` config.

### `next lint` is gone
Run ESLint or Biome directly. `next build` no longer lints, and the `eslint` option in `next.config` was removed.

## Common Gotchas

### `page` and `route` can't share a segment
`app/page.js` next to `app/route.js` is a conflict. Put handlers in their own segment, such as `app/api/…/route.js`.

### Server Components are the default
In the App Router, components are Server Components unless the file starts with `'use client'`. That means:
- No `useState`, `useEffect`, or browser APIs without `'use client'`
- Event handlers like `onClick` need a Client Component
- Server Components can `await` data directly

### `error.tsx` must be a Client Component
`error.tsx` and `global-error.tsx` need `'use client'` at the top, or the build fails.

### What `default.js` does in parallel routes
During soft (client-side) navigation, slots that don't match the new URL keep their previous content. After a hard navigation (a refresh), Next.js can't recover that state, so it renders the slot's `default.js`, or a 404 if there is none.

### There are two caching models
Check `next.config` before applying caching advice:
- **Cache Components** (`cacheComponents: true`): caching is opt-in with `'use cache'`, `cacheLife`, and `cacheTag`. The route segment options `dynamic`, `revalidate`, and `fetchCache` are removed.
- **Previous model** (no `cacheComponents`): `fetch` is not cached by default. Cache a request with `cache: 'force-cache'` or `next: { revalidate }`, or configure a segment with `dynamic` / `revalidate`. Before Next.js 15, `fetch` was cached by default, so upgraded apps can get slower without code changes.

### Proxy runs on every request unless you scope it
Without a `matcher`, proxy runs for every route, including static assets. A common matcher:
```ts
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
```

### `generateStaticParams` doesn't mean fully static
Pages with `generateStaticParams` are prerendered at build time for the listed params. Other params still render on demand unless `dynamicParams = false`.

## File Organization Patterns

### Route groups for auth boundaries
```
app/
├── (public)/          ← no auth required
│   ├── page.tsx       ← landing page
│   └── about/
├── (authenticated)/   ← proxy redirects signed-out users; pages and handlers still check auth
│   ├── dashboard/
│   └── settings/
└── (auth)/            ← login/signup flows
    ├── login/
    └── signup/
```

### Colocating related files
Only `page` and `route` files create routes, so components, tests, and styles can sit next to them:
```
app/dashboard/
├── page.tsx            ← the route
├── dashboard-chart.tsx ← not routable, just a component
├── actions.ts          ← server actions
└── dashboard.test.ts   ← tests
```

### Server actions in separate files
Keep `'use server'` in dedicated action files rather than inline. Auth checks stay consistent, and actions are reusable:
```
app/dashboard/
├── page.tsx
└── actions.ts          ← 'use server' at top; every export is a server action
```

## Performance Patterns

### Use `loading.tsx` for instant navigation
Every route segment can have a `loading.tsx`. It shows immediately during navigation while the page's data loads.

### Fetch in parallel in Server Components
Don't `await` independent requests one after another:
```tsx
// Slow: sequential
const user = await getUser()
const posts = await getPosts()

// Fast: parallel
const [user, posts] = await Promise.all([getUser(), getPosts()])
```

### Route segment config (previous caching model only)
These options don't exist when Cache Components is enabled:
```tsx
// Force static rendering; error if the route uses dynamic APIs
export const dynamic = 'error'

// Revalidate at most every 60 seconds
export const revalidate = 60

// Force dynamic rendering (no caching)
export const dynamic = 'force-dynamic'
```
