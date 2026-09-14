I've been coding with Claude for a long time now, and I kept running into the same problem.

When I use the expensive model (Opus), it does great work — reads my files, understands the architecture, finds real issues. But it costs 5x more per session.

When I use the cheap model (Haiku), it guesses. It reads a few files, then fills in the gaps with things it assumes must be true. On a security audit of a 90-file Next.js app, Haiku invented 7 issues that don't exist in my code — fake CSRF problems, nonexistent password handling, imaginary session management. It found 5 real issues and hallucinated 7.

So I tried something different. Instead of making the model smarter, I gave it better tools.

I built an MCP server called codebase-lens that parses Next.js projects with the TypeScript compiler API. It doesn't read files one by one — it pre-computes the answers to structural questions: which routes have auth, where server code leaks into the client bundle, which exports nothing imports, what the middleware covers and what it misses.

Then I ran the same security audit question across four configurations:

Haiku alone: 5 correct, 7 hallucinated → $0.19
Haiku + codebase-lens: 23 correct, 0 hallucinated → $0.10
Opus alone: 20 correct, 2 hallucinated → $0.47
Opus + codebase-lens: 24 correct, 0 hallucinated → $0.65

The cheap model with the right tools beat the expensive model without them. Half the cost, quarter the time, 4x more accurate, zero hallucinations.

This isn't a new idea in research. AWS published a paper showing a 350M parameter model with tools outperforming ChatGPT on benchmarks. Multiple studies from 2024-2025 confirm that grounding models with structured tools reduces hallucinations. The principle is established: tool access compensates for model size.

But what I haven't seen is anyone using MCP this way. Most MCP servers connect AI to external services — Slack, GitHub, databases. This is different. codebase-lens gives the AI the kind of understanding a senior Next.js developer builds after months in a codebase: the full route tree, the auth coverage map, the client/server boundary graph. It's framework-specific, AST-based, structural knowledge — not file reading.

That matters in two different ways.

If you're a solo developer, this is about cost. You get Opus-quality analysis at Haiku prices. The cheap model stops guessing because it doesn't need to — the tools already computed the answers. You spend $0.10 instead of $0.47 and get better results.

If you're a CTO or tech lead, this is about something bigger. Imagine encoding your architectural rules into the tools: every API route must have auth, no server-only imports in client components, every server action validates input with Zod. Now every developer on your team — running the cheapest model — gets the same guardrails that only your most experienced engineer would catch in code review. A junior dev with Haiku + these tools catches more issues than a senior dev with Opus alone. You're not scaling the model. You're scaling your own engineering judgment across the whole team.

The repo is open source. It's built for Next.js right now, but the same approach — framework-specific AST analysis exposed as MCP tools — works for any framework where structure matters more than syntax. Rails, Django, Laravel, Flutter. The pattern is the same: give the AI the blueprints instead of making it explore the building.

github.com/YOUR_USERNAME/codebase-lens
