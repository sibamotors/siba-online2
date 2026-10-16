# SibaMotor

Task and team workspace (boards, calendar, Gantt, messages, reports, activity log).
Author: Ali Abbasi.

## Stack

TypeScript, React 19, TanStack Start / Router / Query, Tailwind v4, Radix UI.
Data: PostgreSQL (Neon in production, PGlite in development). Hosting: Render. Source: GitHub.

## Conventions

- Login is our own server-side session (`src/lib/session-middleware.ts`, `src/lib/server/*`).
- Every server function uses `authMiddleware` / `adminMiddleware` / `requireBoardAction(...)`
  and takes the caller from `context.user` — never from request data.
- Inputs are validated with zod (`parse(...)` from `src/lib/validate.ts`).
- Server-only code lives in `*.server.ts` and is imported dynamically inside handlers.
- Every meaningful change is written to the audit log (`src/lib/server/audit.server.ts`).
- Database changes go in a new numbered file in `migrations/`; they run on `npm start`.
- No new dependencies without a reason.

## Deployment

See `docs/DEPLOY-FA.md`. New features: `docs/NEW-FEATURES-FA.md`.
