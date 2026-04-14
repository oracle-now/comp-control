# comp-control

An AI-powered browser automation agent for compensation & expense control, built on the **Stagehand + Browserbase + Claude** stack.

> Think of it as giving a senior AP accountant a browser and a policy manual — and letting them run.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     comp-control                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Agent Orchestrator                  │    │
│  │  (Claude claude-sonnet-4-5 system prompt + policy)   │    │
│  └────────────────┬──────────────┬───────────────────────┘  │
│                   │              │                          │
│          ┌────────▼──────┐  ┌────▼──────────┐              │
│          │  Stagehand SDK│  │ Human-in-loop │              │
│          │  act/extract/ │  │  Review Queue │              │
│          │  observe/agent│  │  (approval UI)│              │
│          └────────┬──────┘  └───────────────┘              │
│                   │                                         │
│          ┌────────▼──────┐                                  │
│          │  Browserbase  │  or  Playwright (local mode)     │
│          │  Cloud Chrome │                                  │
│          └───────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

## The Three Layers

| Layer | Technology | Role |
|---|---|---|
| **Brain** | Claude claude-sonnet-4-5 via Anthropic API | Policy decisions, flagging, reasoning |
| **Hands** | Stagehand SDK (`act`, `extract`, `observe`, `agent`) | Browser control primitives |
| **Eyes** | Browserbase (cloud) or Playwright (local) | Managed Chrome with CAPTCHA/session handling |

---

## Quickstart

```bash
git clone https://github.com/oracle-now/comp-control.git
cd comp-control
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY + optional BROWSERBASE_API_KEY
npm run review
```

---

## Project Structure

```
comp-control/
├── src/
│   ├── agents/
│   │   ├── accountant.agent.ts      # Core AP accountant agent
│   │   ├── expense-reviewer.ts      # Expense policy enforcement
│   │   └── escalation-handler.ts   # Unusual item escalation
│   ├── browser/
│   │   ├── session.ts               # Browserbase / Playwright session factory
│   │   └── stagehand.config.ts      # Stagehand initialization
│   ├── policy/
│   │   ├── rules.ts                 # Configurable expense policy rules
│   │   └── prompts.ts               # System prompts for the LLM
│   ├── ui/
│   │   └── review-dashboard.html   # Human-in-the-loop review UI
│   ├── workflows/
│   │   ├── ramp-approvals.ts        # Ramp.com approval workflow
│   │   ├── expensify-review.ts      # Expensify workflow
│   │   └── generic-workflow.ts      # Template for custom SaaS targets
│   └── index.ts                     # CLI entrypoint
├── config/
│   └── policy.yaml                  # Declarative expense policy config
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration (`config/policy.yaml`)

The agent's behavior is driven entirely by `policy.yaml` — no code changes needed for policy updates.

```yaml
# See config/policy.yaml for the full schema
limits:
  auto_approve_under: 100       # Auto-approve if under $100 and valid category
  flag_for_review_over: 500     # Flag anything over $500
  require_receipt_over: 25      # Require receipt for anything over $25

categories:
  allowed: ["travel", "meals", "software", "office_supplies"]
  always_flag: ["entertainment", "alcohol", "gifts"]

human_in_loop:
  enabled: true
  require_approval_for_flags: true  # Agent pauses on flags, waits for human
  timeout_minutes: 60
```

---

## Modes

### Local Mode (Free)
```bash
npm run review -- --mode local
```
Runs Playwright headless Chrome locally. Costs: LLM API only (~$0.50/day moderate workload).

### Cloud Mode (Browserbase)
```bash
npm run review -- --mode cloud
```
Runs via Browserbase. CAPTCHA handling, residential proxies, persistent sessions.

### Dry Run
```bash
npm run review -- --dry-run
```
Agent reads and classifies expenses but never clicks Approve. Outputs a report only.

---

## Human-in-the-Loop

The agent pauses before any flagged action and writes to a local review queue. The review dashboard (`src/ui/review-dashboard.html`) provides a visual interface to:
- See what the agent flagged and why
- Approve or reject with one click
- Add notes that feed back into the agent's context

**The agent never approves flagged items autonomously.** This is enforced at the code level, not just the prompt level.

---

## Cost Model

| Mode | Fixed Cost | Variable Cost | Estimated Daily |
|---|---|---|---|
| Local + Claude | $0 | ~$0.003–0.015/page | < $1/day |
| Cloud (Browserbase Starter) | $49/mo | Same LLM cost | ~$1.60/day all-in |
| With Caching | $0/$49 | ~80% LLM reduction | < $0.25/day |

Stagehand's selector caching eliminates LLM calls on repeat page layouts — the biggest cost lever.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Claude API key |
| `BROWSERBASE_API_KEY` | No | Only for cloud mode |
| `BROWSERBASE_PROJECT_ID` | No | Only for cloud mode |
| `TARGET_URL` | Yes | The expense platform URL |
| `TARGET_EMAIL` | Yes | Login email |
| `TARGET_PASSWORD` | Yes | Login password (use a secrets manager in prod) |
| `HUMAN_REVIEW_PORT` | No | Port for review dashboard (default: 3001) |

---

## Limitations & Honest Notes

- **Best on stable SaaS UIs.** If the target app redesigns, selectors may break. The agent will observe and adapt, but test after major updates.
- **CAPTCHA mid-flow:** Browserbase handles this. Local mode may stall.
- **Never use for truly irreversible actions** without human-in-loop enabled. Approvals can often be reversed; use your platform's audit log.
- **Not a replacement for proper AP software.** This is an automation layer, not a financial system of record.

---

## License

MIT
