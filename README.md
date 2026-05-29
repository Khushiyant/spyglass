# Spyglass

An autonomous engineering-investigation agent built on top of [Coral](https://withcoral.com).

Spyglass takes a plain-English question about your stack — *"checkout-service
threw a wall of errors on April 18 — find the root cause"* — and a Claude agent
loop figures out which data sources to connect, writes its own cross-source SQL
through Coral, and narrates the answer.

No hardcoded queries. No pre-configured sources. The agent discovers what's
connectable at runtime, connects only what it needs, and writes every SQL
statement live.

Built for [Pirates of the Coral-bean](https://www.wemakedevs.org/hackathons/coral)
(WeMakeDevs × Coral).

---

## Architecture

Three layers:

```
EDGE     browser  ←──(SSE stream)──→  Next.js /api/chat
                                              │
BRAIN                                         ▼
                                         agent loop  ←──tool_use──┐
                                         (max 10 steps)            │
                                              │                    │
                                              └──messages.stream──▶  Claude Sonnet 4.6
                                              │
                                              ▼ run_coral_sql
DATA                                    Coral CLI
                                        (DataFusion · SQL)
                                              │
                            ┌──────┬──────────┼──────────┬──────┐
                            ▼      ▼          ▼          ▼      ▼
                         github  sentry    datadog    linear  stripe
                         (YAML manifests, backend=file for the demo;
                          swap to backend=http for live APIs)
```

The agent has exactly four tools, each backed by a Coral primitive:

| Tool                          | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `list_available_sources()`    | Reads `coral.tables` + the local manifest directory; reports which sources are connected and which could be connected. |
| `connect_source(name)`        | Shells out to `coral source add --file <manifest>.yaml`. Idempotent.   |
| `describe_source(source)`     | Queries `coral.columns` for the schema of a connected source.         |
| `run_coral_sql(sql)`          | Runs `coral sql --format json "<query>"`. SELECT/WITH only.           |

Drop a sixth source manifest into `coral/manifests/` and the agent picks it up
on the next question. No code changes.

## Repository layout

```
spyglass/
├── coral/
│   └── manifests/      Five Coral source specs (backend: file, JSONL fixtures)
├── frontend/           Next.js 16 agent UI
│   ├── app/
│   │   ├── api/chat/   SSE endpoint that runs the agent loop
│   │   └── page.tsx    Scope dashboard — investigation canvas, reading
│   │                   panel, live probes log
│   └── lib/
│       ├── agent.ts    Claude tool-use loop with streaming
│       └── coral.ts    Coral CLI wrapper + introspection helpers
└── scripts/
    ├── generate_fixtures.py     Generates 90 days of synthetic engineering
    │                            data (Reefline Inc., 200k rows)
    ├── install_sources_demo.sh  Concise installer — one line per source
    ├── install_sources.sh       Verbose installer with full Coral output
    └── killer-query.sql         The 5-source JOIN example
```

## Running it

Requirements: Node 20+, Python 3.10+, [Coral CLI](https://withcoral.com),
an `ANTHROPIC_API_KEY`.

```bash
# 1. install Coral
curl -fsSL https://withcoral.com/install.sh | INSTALL_DIR=$HOME/.local/bin sh
export PATH=$HOME/.local/bin:$PATH

# 2. generate the synthetic data
python3 scripts/generate_fixtures.py

# 3. install the frontend
cd frontend
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local

# 4. start
npm run dev
```

Open `http://localhost:3000`, type a question, watch the agent work. It will
call `connect_source` on the manifests in `coral/manifests/` as it decides
it needs them — nothing is pre-installed.

If you want all five sources pre-installed (handy for non-demo use):

```bash
./scripts/install_sources.sh
```

## Cross-source query example

The query the agent often arrives at for "which PRs caused which incidents"
JOINs all five sources in a single statement — see
[`scripts/killer-query.sql`](scripts/killer-query.sql).

It returns one row per high-volume Sentry incident, with the culprit PR, the
count of failed Stripe charges during the incident window, the peak Datadog
p99 latency, and the linked Linear ticket — pulled out of five completely
different sources in one query.

## What's synthetic

The data is invented — there is no real Stripe account, no real GitHub
repository, no real Sentry org. `scripts/generate_fixtures.py` produces 90
days of activity for a fictional company called Reefline, with three
narrative incidents woven through the JSONL fixtures.

To point Spyglass at real APIs, change the manifest backends in
`coral/manifests/*.yaml` from `backend: file` to `backend: http` and add the
appropriate auth — Coral has the templates. The agent and the UI don't
change a line.

## License

MIT.
