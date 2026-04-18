# AGENTS.md — comp-control

> Auto-loaded by Codex, Cursor, Claude, and most AI coding agents.
> Read this entire file before touching any code.

---

## What This Repo Is

AI-powered browser automation agent for compensation & expense control.

- Claude reasons about expense policy and makes approval/flag decisions
- Stagehand SDK (`act`, `extract`, `observe`, `agent`) controls the browser
- Browserbase (cloud) or Playwright (local) provides the managed Chrome session
- Human-in-the-loop review queue pauses the agent on flagged items
- `config/policy.yaml` is the declarative policy config — no code for policy changes

> "A senior AP accountant with a browser and a policy manual."

**Status:** Active. Supports Ramp, Expensify, and generic SaaS targets.

---

## Repo Structure

```
comp-control/
├── src/
│   ├── agents/          # Core agent logic (accountant, reviewer, escalation)
│   ├── browser/         # Browserbase / Playwright session factory + Stagehand config
│   ├── policy/          # Expense policy rules + LLM system prompts
│   ├── ui/              # Human-in-the-loop review dashboard (static HTML)
│   └── workflows/       # Per-platform workflows (Ramp, Expensify, generic)
├── config/
│   └── policy.yaml      # THE policy source of truth — edit here, not in code
└── .env.example
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Brain | Claude claude-sonnet-4-5 (Anthropic API) |
| Hands | Stagehand SDK (`act`, `extract`, `observe`, `agent`) |
| Eyes | Browserbase (cloud) or Playwright (local) |
| Language | TypeScript (Node.js) |
| Deploy | Railway (railway.toml + railpack.json) |
| Policy config | config/policy.yaml |

---

## Critical Architecture Rules

### 1. `config/policy.yaml` is the ONLY place for policy changes
Auto-approve thresholds, flag-over limits, receipt requirements, allowed/blocked
categories — all of it lives in `policy.yaml`. Never hardcode a dollar amount,
category name, or policy rule in TypeScript. If it's a business decision, it
belongs in config.

### 2. The agent NEVER autonomously approves flagged items — enforce at code level
This is enforced in code, not just in the system prompt. The human-in-the-loop
review queue must gate every flagged action. Do not add any code path that
bypasses the review queue for flagged items, regardless of timeout or fallback.

### 3. Dry-run mode must stay safe by default
`--dry-run` means the agent reads and classifies but never clicks. Never add a
side effect (approve, reject, submit) that runs in dry-run mode. If you add a
new action, explicitly check `isDryRun` before executing it.

### 4. Stagehand selector caching is the primary cost lever
Stagehand caches selectors for repeat page layouts, which eliminates redundant
LLM calls. Do not bypass the cache or force fresh observations on every run
unless the target UI has actually changed. Unnecessary `observe()` calls are
the biggest cost driver (~80% of LLM spend).

### 5. Browserbase vs Playwright — cloud mode is not always better
Local Playwright mode is free (LLM API cost only). Use Browserbase only when:
- The target platform has CAPTCHA mid-flow
- Session persistence across runs is required
- The target blocks residential IPs
Never default to Browserbase to "be safe" — it adds cost for no benefit on
stable internal tools like Ramp.

### 6. Credentials must never be logged or thrown in exceptions
`TARGET_EMAIL` and `TARGET_PASSWORD` are live credentials. Wrap all auth flows
in try/catch. Exception messages must never include credential values. Use
`[REDACTED]` in any error output that references auth state.

### 7. New workflows go in `src/workflows/` — not in agents
Platform-specific logic (Ramp, Expensify, custom SaaS) belongs in
`src/workflows/`. Agents in `src/agents/` must remain platform-agnostic.
A workflow imports an agent — not the other way around.

---

## Modes

| Mode | Command | Behavior |
|---|---|---|
| Local | `npm run review -- --mode local` | Playwright headless, LLM cost only |
| Cloud | `npm run review -- --mode cloud` | Browserbase, CAPTCHA handled |
| Dry run | `npm run review -- --dry-run` | Read + classify only, no clicks |

Always test new workflows in `--dry-run` first.

---

## Pre-Ship Checklist

Before committing any change, verify:

- [ ] Policy change? → In `config/policy.yaml`, not hardcoded in TypeScript
- [ ] New action (approve/reject/submit)? → Explicitly gated on `isDryRun` check
- [ ] Any flagged-item path? → Cannot reach approval without passing through review queue
- [ ] New `observe()` call? → Necessary? Could cached selector cover this?
- [ ] Auth flow touched? → Credentials not in any exception message or log
- [ ] New workflow? → Lives in `src/workflows/`, agent stays platform-agnostic
- [ ] `npm run build` passes with no TypeScript errors before pushing
