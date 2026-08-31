# DonutSMP Elytra Market Tracker

Live market dashboard for qualifying DonutSMP Elytras, with persistent price observations, listing activity, and data-backed market alerts.

## Run & Operate

- `PORT=8080 NODE_ENV=development pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `PORT=23509 BASE_PATH=/ NODE_ENV=development pnpm --filter @workspace/elytra-market-tracker run dev` — run the web dashboard (port 23509)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `DONUTSMP_API_KEY` for market polling and `GEMINI_API_KEY` for native Google Gemini analysis

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/elytra-market-tracker/src/pages/dashboard.tsx` — responsive dashboard UI and market filters
- `artifacts/api-server/src/lib/elytra-market.ts` — centralized DonutSMP polling, normalization, rate limiting, persistence, and alert detection
- `artifacts/api-server/src/routes/elytra.ts` — validated market API routes
- `lib/api-spec/openapi.yaml` — source of truth for the generated API client and Zod response schemas
- `lib/db/src/schema/elytra.ts` — persistent listings, observations, market activity, and alert tables

## Architecture decisions

- DonutSMP polling is centralized in the API server, so browser visitors share one cached snapshot and cannot multiply upstream traffic.
- The API server makes one lowest-price page request every five seconds, then records the lowest returned price as a real market snapshot. Browser visitors share this cached feed and cannot multiply upstream traffic.
- Massive buy alerts fire when at least 10 units disappear from active listings; massive sell alerts fire when at least 10 units are added. Lowest-price movement is included as context, with no fixed coin threshold.
- The live feed is currently scoped to every Elytra returned by DonutSMP's `search: elytra` request; enchantment filtering is intentionally deferred.
- The auction endpoint provides current listings, not a sale ledger, so the activity panel is explicitly labeled as observed market activity rather than fabricated completed sales.
- Gemini analysis is server-only through Google’s native `generateContent` endpoint using `gemini-flash-latest`, capped at five calls per rolling hour; market analysis sends auction pages one and two plus the selected real price-history range, while the key stays in Replit Secrets.

## Product

Users can view current Elytra statistics, filter an observed lowest-price history by range, sort/search listings, inspect recent observed activity, and review alerts generated from real changes in listing supply and price.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The DonutSMP API key is server-only in `DONUTSMP_API_KEY`; it must never be read by the frontend.
- The Google Gemini key is server-only in `GEMINI_API_KEY`; the UI can request Gemini analysis but must never receive the key.
- Empty market data is represented with null price fields and empty collections; the UI must not replace unavailable data with zeros or synthetic points.
- DonutSMP auction responses wrap records in `result`, nest seller data, and encode remaining time in milliseconds.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
