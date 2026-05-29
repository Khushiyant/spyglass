"""Generate 90 days of synthetic multi-source engineering data for Reefline Inc.

Embeds three narrative incidents that become visible when JOINed across sources:
  1. 2026-04-18  Rate-limiter regression (PR -> Sentry -> Datadog -> Linear -> Stripe)
  2. 2026-03-22  Auth-migration churn (commits over a week -> support tickets -> subs cancels)
  3. 2026-05-09  Stripe webhook deadlock (DB pool exhaustion overnight)

Output: one JSONL file per (source, table) under coral/data/<source>/<table>.jsonl
"""

from __future__ import annotations

import hashlib
import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

random.seed(7)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "coral" / "data"

START = datetime(2026, 3, 1, tzinfo=UTC)
END = datetime(2026, 5, 28, 23, 59, tzinfo=UTC)

ENGINEERS = [
    ("alice", "alice@reefline.io"),
    ("bob", "bob@reefline.io"),
    ("carmen", "carmen@reefline.io"),
    ("dax", "dax@reefline.io"),
    ("ezra", "ezra@reefline.io"),
    ("freya", "freya@reefline.io"),
    ("gus", "gus@reefline.io"),
    ("hana", "hana@reefline.io"),
]

SERVICES = ["checkout-service", "auth-service", "billing-service", "api-gateway", "webhook-worker"]

FILES_BY_SERVICE = {
    "checkout-service": [
        "services/checkout/cart.py", "services/checkout/rate_limit.py",
        "services/checkout/handler.py", "services/checkout/validators.py",
    ],
    "auth-service": [
        "services/auth/session.py", "services/auth/middleware.py",
        "services/auth/tokens.py", "services/auth/migrations/0042_session_keys.sql",
    ],
    "billing-service": [
        "services/billing/invoices.py", "services/billing/subscriptions.py",
        "services/billing/proration.py",
    ],
    "api-gateway": ["services/gateway/router.py", "services/gateway/limits.py"],
    "webhook-worker": [
        "services/webhooks/stripe.py", "services/webhooks/dispatcher.py",
        "services/webhooks/pool.py",
    ],
}


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha(seed: str) -> str:
    return hashlib.sha1(seed.encode()).hexdigest()[:12]


def daterange(start: datetime, end: datetime, step: timedelta):
    cur = start
    while cur < end:
        yield cur
        cur += step


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"  wrote {len(rows):>5} rows -> {path.relative_to(ROOT)}")


# ------------------------------------------------------------------ background

def gen_background_commits_and_pulls() -> tuple[list[dict], list[dict]]:
    """Routine commits sprinkled across the window. Each commit also produces a PR row."""
    commits: list[dict] = []
    pulls: list[dict] = []
    pr_counter = 100
    for day in daterange(START, END, timedelta(days=1)):
        n = random.randint(3, 9) if day.weekday() < 5 else random.randint(0, 2)
        for _ in range(n):
            who = random.choice(ENGINEERS)
            svc = random.choice(SERVICES)
            files = random.sample(FILES_BY_SERVICE[svc], k=min(2, len(FILES_BY_SERVICE[svc])))
            t = day.replace(hour=random.randint(9, 19), minute=random.randint(0, 59))
            pr_counter += 1
            verb, scope = random.choice([
                ("chore", "tidy logging"),
                ("refactor", "extract helper"),
                ("feat", "add metric"),
                ("fix", "null check"),
                ("test", "add coverage"),
                ("perf", "skip cold path"),
                ("docs", "comments"),
            ])
            msg = f"{verb}({svc}): {scope}"
            additions = random.randint(3, 80)
            deletions = random.randint(0, 40)
            commits.append({
                "sha": sha(f"{t}-{who[0]}-{msg}"),
                "author": who[0], "author_email": who[1],
                "message": msg, "files": files,
                "additions": additions, "deletions": deletions,
                "committed_at": iso(t), "service": svc,
                "pr_number": pr_counter, "branch": "main",
            })
            pulls.append({
                "number": pr_counter,
                "title": f"{verb}({svc}): {scope}",
                "author": who[0], "author_email": who[1],
                "state": "merged",
                "created_at": iso(t - timedelta(hours=random.randint(2, 30))),
                "merged_at": iso(t),
                "service": svc,
                "additions": additions, "deletions": deletions,
                "files_changed": files,
                "url": f"https://github.com/reefline/monorepo/pull/{pr_counter}",
            })
    return commits, pulls


def gen_background_sentry() -> list[dict]:
    """Steady-state error stream — flat baseline per service."""
    rows = []
    eid = 0
    for day in daterange(START, END, timedelta(hours=1)):
        for svc in SERVICES:
            n = random.choices([0, 1, 2], weights=[6, 3, 1])[0]
            for _ in range(n):
                eid += 1
                t = day + timedelta(minutes=random.randint(0, 59))
                rows.append({
                    "event_id": f"evt_{eid:08d}",
                    "issue_id": f"iss_{svc}_baseline",
                    "service": svc,
                    "level": random.choice(["warning", "error", "error"]),
                    "title": random.choice([
                        "TimeoutError", "ValidationError", "NotFoundError", "ConnectionResetError",
                    ]),
                    "message": "background noise",
                    "timestamp": iso(t),
                    "release": f"v2.{(t - START).days + 320}.0",
                    "user_id": f"usr_{random.randint(1, 5000)}",
                })
    return rows


def gen_background_datadog() -> list[dict]:
    """Steady metrics: latency p99 + error_rate per service, one point per 15 min."""
    rows = []
    base_latency = {"checkout-service": 180, "auth-service": 90, "billing-service": 120,
                    "api-gateway": 60, "webhook-worker": 240}
    for t in daterange(START, END, timedelta(minutes=15)):
        for svc in SERVICES:
            jitter = random.uniform(0.85, 1.15)
            rows.append({
                "metric": "http.latency_p99_ms",
                "service": svc,
                "value": round(base_latency[svc] * jitter, 1),
                "timestamp": iso(t),
            })
            rows.append({
                "metric": "http.error_rate",
                "service": svc,
                "value": round(random.uniform(0.001, 0.012), 4),
                "timestamp": iso(t),
            })
    return rows


def gen_background_linear() -> list[dict]:
    """Routine tickets across the window."""
    rows = []
    for i in range(120):
        created = START + timedelta(days=random.randint(0, (END - START).days),
                                    hours=random.randint(0, 23))
        completed_offset = random.randint(1, 14)
        completed = created + timedelta(days=completed_offset)
        state = "Done" if completed < END else "In Progress"
        rows.append({
            "id": f"REE-{700 + i}",
            "title": random.choice([
                "Improve cart page load time",
                "Add audit log to admin actions",
                "Migrate logs to OpenObserve",
                "Tune Datadog dashboards",
                "Refactor billing proration",
                "Add SSO to staging environment",
                "Increase test coverage on webhook worker",
            ]),
            "state": state,
            "assignee": random.choice(ENGINEERS)[1],
            "priority": random.choice([2, 3, 3, 4]),
            "labels": random.sample(["enhancement", "tech-debt", "infra", "frontend", "backend"], k=2),
            "created_at": iso(created),
            "completed_at": iso(completed) if state == "Done" else None,
        })
    return rows


def gen_background_stripe() -> list[dict]:
    """Steady stream of successful charges with rare failures."""
    rows = []
    cid = 0
    for t in daterange(START, END, timedelta(minutes=5)):
        n = random.randint(2, 6)
        for _ in range(n):
            cid += 1
            failed = random.random() < 0.018
            rows.append({
                "id": f"ch_{cid:08d}",
                "amount": random.choice([1900, 2900, 4900, 9900, 19900]),
                "currency": "usd",
                "status": "failed" if failed else "succeeded",
                "customer_id": f"cus_{random.randint(1, 2400):06d}",
                "created": iso(t + timedelta(seconds=random.randint(0, 299))),
                "failure_code": "card_declined" if failed else None,
            })
    return rows


# --------------------------------------------------------------- the incidents

def incident_rate_limiter(commits, pulls, sentry_events, sentry_issues,
                          datadog, linear_issues, stripe_charges):
    """2026-04-18 14:03 UTC — Alice merges PR #347 tightening the checkout rate limiter.
    Bug: off-by-one in window calculation rejects 30% of legitimate traffic.
    Visible as: Sentry 5xx spike, Datadog p99 jump, Linear incident, Stripe failed charges.
    Rolled back at 15:42 by Bob via PR #348.
    """
    base = datetime(2026, 4, 18, 14, 3, tzinfo=UTC)

    pulls.append({
        "number": 347,
        "title": "Tighten checkout rate limiter window",
        "author": "alice", "author_email": "alice@reefline.io",
        "state": "merged",
        "created_at": iso(base - timedelta(days=1, hours=4)),
        "merged_at": iso(base),
        "service": "checkout-service",
        "additions": 24, "deletions": 9,
        "files_changed": ["services/checkout/rate_limit.py", "services/checkout/handler.py"],
        "url": "https://github.com/reefline/monorepo/pull/347",
    })
    commits.append({
        "sha": sha("ratelimit-merge"), "author": "alice", "author_email": "alice@reefline.io",
        "message": "feat(checkout): tighten rate limiter window (#347)",
        "files": ["services/checkout/rate_limit.py", "services/checkout/handler.py"],
        "additions": 24, "deletions": 9, "committed_at": iso(base),
        "service": "checkout-service", "pr_number": 347, "branch": "main",
    })

    pulls.append({
        "number": 348,
        "title": "Revert: tighten checkout rate limiter window (#347)",
        "author": "bob", "author_email": "bob@reefline.io",
        "state": "merged",
        "created_at": iso(base + timedelta(hours=1, minutes=30)),
        "merged_at": iso(base + timedelta(hours=1, minutes=39)),
        "service": "checkout-service",
        "additions": 9, "deletions": 24,
        "files_changed": ["services/checkout/rate_limit.py", "services/checkout/handler.py"],
        "url": "https://github.com/reefline/monorepo/pull/348",
    })
    commits.append({
        "sha": sha("ratelimit-revert"), "author": "bob", "author_email": "bob@reefline.io",
        "message": "revert: tighten checkout rate limiter window (#347)",
        "files": ["services/checkout/rate_limit.py", "services/checkout/handler.py"],
        "additions": 9, "deletions": 24,
        "committed_at": iso(base + timedelta(hours=1, minutes=39)),
        "service": "checkout-service", "pr_number": 348, "branch": "main",
    })

    sentry_issues.append({
        "id": "iss_checkout_ratelimit_apr18",
        "title": "RateLimitExceeded in /api/checkout",
        "service": "checkout-service",
        "level": "error",
        "first_seen": iso(base + timedelta(minutes=15)),
        "last_seen": iso(base + timedelta(hours=1, minutes=42)),
        "events_count": 1840, "users_affected": 612,
    })
    for i in range(380):
        t = base + timedelta(minutes=15) + timedelta(seconds=random.randint(0, 90 * 60))
        sentry_events.append({
            "event_id": f"evt_rl_{i:04d}",
            "issue_id": "iss_checkout_ratelimit_apr18",
            "service": "checkout-service",
            "level": "error",
            "title": "RateLimitExceeded",
            "message": "Request rejected: tokens=0 window=60s",
            "timestamp": iso(t),
            "release": "v2.366.0",
            "user_id": f"usr_{random.randint(1, 5000)}",
        })

    for offset_min in range(0, 110, 5):
        t = base + timedelta(minutes=offset_min)
        spike_factor = 1.0
        if 15 <= offset_min <= 99:
            spike_factor = 6.5 if 30 <= offset_min <= 80 else 3.2
        datadog.append({
            "metric": "http.latency_p99_ms", "service": "checkout-service",
            "value": round(180 * spike_factor, 1), "timestamp": iso(t),
        })
        datadog.append({
            "metric": "http.error_rate", "service": "checkout-service",
            "value": round(min(0.42, 0.006 * spike_factor * 8), 4) if spike_factor > 1 else 0.006,
            "timestamp": iso(t),
        })

    linear_issues.append({
        "id": "REE-892",
        "title": "Checkout intermittent failures — RateLimitExceeded errors",
        "state": "Done",
        "assignee": "bob@reefline.io",
        "priority": 1,
        "labels": ["incident", "checkout", "sev2"],
        "created_at": iso(base + timedelta(minutes=32)),
        "completed_at": iso(base + timedelta(hours=2)),
    })
    linear_issues.append({
        "id": "REE-893",
        "title": "Postmortem: Apr 18 checkout rate limiter regression",
        "state": "Done",
        "assignee": "alice@reefline.io",
        "priority": 2,
        "labels": ["postmortem", "checkout"],
        "created_at": iso(base + timedelta(days=1)),
        "completed_at": iso(base + timedelta(days=3)),
    })

    for i in range(23):
        t = base + timedelta(minutes=18) + timedelta(minutes=random.randint(0, 80))
        stripe_charges.append({
            "id": f"ch_rl_apr18_{i:03d}",
            "amount": random.choice([2900, 4900, 9900, 19900]),
            "currency": "usd", "status": "failed",
            "customer_id": f"cus_{random.randint(1, 2400):06d}",
            "created": iso(t),
            "failure_code": "payment_intent_failed",
        })


def incident_auth_migration(commits, pulls, sentry_events, sentry_issues,
                            linear_issues, stripe_charges):
    """2026-03-22 onward — a week-long auth middleware migration.
    Subtle bug: refresh tokens for users with non-ASCII display names get rejected.
    Slow burn: cancellations cluster, support tickets pile up, new Sentry issue grows."""
    start = datetime(2026, 3, 22, 10, 0, tzinfo=UTC)
    for i, day_offset in enumerate(range(0, 7)):
        t = start + timedelta(days=day_offset, hours=random.randint(0, 6))
        pulls.append({
            "number": 310 + i,
            "title": f"Auth middleware migration step {i+1}/7",
            "author": "carmen", "author_email": "carmen@reefline.io",
            "state": "merged",
            "created_at": iso(t - timedelta(hours=3)),
            "merged_at": iso(t),
            "service": "auth-service",
            "additions": random.randint(60, 220), "deletions": random.randint(30, 180),
            "files_changed": random.sample(FILES_BY_SERVICE["auth-service"], k=3),
            "url": f"https://github.com/reefline/monorepo/pull/{310+i}",
        })
        commits.append({
            "sha": sha(f"auth-mig-{i}"), "author": "carmen", "author_email": "carmen@reefline.io",
            "message": f"refactor(auth): migrate middleware step {i+1}/7 (#{310+i})",
            "files": random.sample(FILES_BY_SERVICE["auth-service"], k=3),
            "additions": random.randint(60, 220), "deletions": random.randint(30, 180),
            "committed_at": iso(t), "service": "auth-service", "pr_number": 310 + i,
            "branch": "main",
        })

    sentry_issues.append({
        "id": "iss_auth_invalid_session_mar22",
        "title": "InvalidSessionToken: unable to decode refresh token",
        "service": "auth-service", "level": "error",
        "first_seen": iso(start + timedelta(hours=18)),
        "last_seen": iso(start + timedelta(days=12)),
        "events_count": 4280, "users_affected": 318,
    })
    for i in range(640):
        t = start + timedelta(hours=18) + timedelta(seconds=random.randint(0, 12 * 86400))
        sentry_events.append({
            "event_id": f"evt_auth_{i:04d}",
            "issue_id": "iss_auth_invalid_session_mar22",
            "service": "auth-service",
            "level": "error",
            "title": "InvalidSessionToken",
            "message": "decode failed: invalid base64 in display_name claim",
            "timestamp": iso(t),
            "release": "v2.341.0",
            "user_id": f"usr_{random.randint(1, 5000)}",
        })

    linear_issues.append({
        "id": "REE-820",
        "title": "Customers report being logged out repeatedly after Mar 22 deploy",
        "state": "Done", "assignee": "carmen@reefline.io", "priority": 2,
        "labels": ["customer-impact", "auth"],
        "created_at": iso(start + timedelta(days=2)),
        "completed_at": iso(start + timedelta(days=14)),
    })
    linear_issues.append({
        "id": "REE-841",
        "title": "Spike in subscription cancellations — investigate",
        "state": "Done", "assignee": "dax@reefline.io", "priority": 2,
        "labels": ["billing", "growth"],
        "created_at": iso(start + timedelta(days=5)),
        "completed_at": iso(start + timedelta(days=10)),
    })

    for i in range(38):
        t = start + timedelta(days=random.randint(2, 11), hours=random.randint(0, 23))
        stripe_charges.append({
            "id": f"ch_auth_mar22_{i:03d}",
            "amount": random.choice([1900, 2900, 9900]),
            "currency": "usd", "status": "succeeded",
            "customer_id": f"cus_{random.randint(1, 2400):06d}",
            "created": iso(t),
            "failure_code": None,
            "metadata_event": "subscription.canceled",
        })


def incident_webhook_deadlock(commits, pulls, sentry_events, sentry_issues,
                              datadog, linear_issues):
    """2026-05-09 — A PR merged the prior afternoon holds a DB transaction
    across an outbound HTTP call. Connection pool exhausted overnight."""
    bad = datetime(2026, 5, 8, 16, 18, tzinfo=UTC)
    night = datetime(2026, 5, 9, 2, 22, tzinfo=UTC)

    pulls.append({
        "number": 412,
        "title": "Persist Stripe webhook ack inside event tx",
        "author": "ezra", "author_email": "ezra@reefline.io",
        "state": "merged",
        "created_at": iso(bad - timedelta(hours=6)),
        "merged_at": iso(bad),
        "service": "webhook-worker",
        "additions": 31, "deletions": 12,
        "files_changed": ["services/webhooks/stripe.py", "services/webhooks/pool.py"],
        "url": "https://github.com/reefline/monorepo/pull/412",
    })
    commits.append({
        "sha": sha("webhook-deadlock"),
        "author": "ezra", "author_email": "ezra@reefline.io",
        "message": "feat(webhooks): persist Stripe ack inside event tx (#412)",
        "files": ["services/webhooks/stripe.py", "services/webhooks/pool.py"],
        "additions": 31, "deletions": 12, "committed_at": iso(bad),
        "service": "webhook-worker", "pr_number": 412, "branch": "main",
    })

    sentry_issues.append({
        "id": "iss_webhook_pool_may09",
        "title": "PoolTimeoutError: QueuePool limit reached",
        "service": "webhook-worker", "level": "error",
        "first_seen": iso(night),
        "last_seen": iso(night + timedelta(hours=5)),
        "events_count": 2210, "users_affected": 0,
    })
    for i in range(420):
        t = night + timedelta(seconds=random.randint(0, 5 * 3600))
        sentry_events.append({
            "event_id": f"evt_wh_{i:04d}",
            "issue_id": "iss_webhook_pool_may09",
            "service": "webhook-worker", "level": "error",
            "title": "PoolTimeoutError",
            "message": "QueuePool limit of size 20 overflow 10 reached",
            "timestamp": iso(t),
            "release": "v2.384.0",
            "user_id": None,
        })

    for offset_min in range(0, 360, 5):
        t = night + timedelta(minutes=offset_min)
        spike = 1.0
        if 0 <= offset_min <= 310:
            spike = 9.4 if 30 <= offset_min <= 240 else 4.0
        datadog.append({
            "metric": "db.pool.usage_pct", "service": "webhook-worker",
            "value": round(min(100.0, 22.0 * spike), 1), "timestamp": iso(t),
        })
        datadog.append({
            "metric": "http.error_rate", "service": "webhook-worker",
            "value": round(min(0.61, 0.012 * spike * 6), 4) if spike > 1 else 0.012,
            "timestamp": iso(t),
        })

    linear_issues.append({
        "id": "REE-961",
        "title": "Webhook worker DB pool exhausted overnight — Stripe events delayed",
        "state": "Done", "assignee": "ezra@reefline.io", "priority": 1,
        "labels": ["incident", "webhooks", "sev2"],
        "created_at": iso(night + timedelta(hours=6)),
        "completed_at": iso(night + timedelta(days=1, hours=4)),
    })


def pending_risky_prs(pulls, commits):
    """A pair of recent PRs designed to *rhyme* with past incidents.
    Spyglass's Foresee module should flag these prominently."""
    risky = [
        {
            "merged_at": "2026-05-25T13:40:00Z",
            "service": "checkout-service",
            "title": "Refine checkout rate limiter window for spikes",
            "author": ("freya", "freya@reefline.io"),
            "files": ["services/checkout/rate_limit.py", "services/checkout/handler.py"],
            "additions": 38, "deletions": 14,
            "number": 491,
        },
        {
            "merged_at": "2026-05-26T11:20:00Z",
            "service": "webhook-worker",
            "title": "Persist Stripe ack inside webhook tx (retry)",
            "author": ("ezra", "ezra@reefline.io"),
            "files": ["services/webhooks/stripe.py", "services/webhooks/pool.py"],
            "additions": 41, "deletions": 9,
            "number": 492,
        },
        {
            "merged_at": "2026-05-27T16:05:00Z",
            "service": "auth-service",
            "title": "Auth middleware migration step 8/7: cleanup",
            "author": ("carmen", "carmen@reefline.io"),
            "files": ["services/auth/session.py", "services/auth/middleware.py"],
            "additions": 142, "deletions": 88,
            "number": 493,
        },
    ]
    for r in risky:
        t = datetime.fromisoformat(r["merged_at"].replace("Z", "+00:00"))
        pulls.append({
            "number": r["number"], "title": r["title"],
            "author": r["author"][0], "author_email": r["author"][1],
            "state": "merged",
            "created_at": iso(t - timedelta(hours=6)),
            "merged_at": iso(t),
            "service": r["service"],
            "additions": r["additions"], "deletions": r["deletions"],
            "files_changed": r["files"],
            "url": f"https://github.com/reefline/monorepo/pull/{r['number']}",
        })
        commits.append({
            "sha": sha(f"risky-{r['number']}"),
            "author": r["author"][0], "author_email": r["author"][1],
            "message": r["title"], "files": r["files"],
            "additions": r["additions"], "deletions": r["deletions"],
            "committed_at": iso(t), "service": r["service"],
            "pr_number": r["number"], "branch": "main",
        })


# -------------------------------------------------------------------- assemble

def main() -> None:
    print("Generating Reefline synthetic fixtures...")
    commits, pulls = gen_background_commits_and_pulls()
    sentry_events = gen_background_sentry()
    sentry_issues: list[dict] = []
    for svc in SERVICES:
        sentry_issues.append({
            "id": f"iss_{svc}_baseline",
            "title": f"{svc} baseline noise",
            "service": svc, "level": "warning",
            "first_seen": iso(START), "last_seen": iso(END),
            "events_count": sum(1 for e in sentry_events if e["service"] == svc),
            "users_affected": random.randint(20, 90),
        })
    datadog = gen_background_datadog()
    linear_issues = gen_background_linear()
    stripe_charges = gen_background_stripe()

    incident_rate_limiter(commits, pulls, sentry_events, sentry_issues,
                          datadog, linear_issues, stripe_charges)
    incident_auth_migration(commits, pulls, sentry_events, sentry_issues,
                            linear_issues, stripe_charges)
    incident_webhook_deadlock(commits, pulls, sentry_events, sentry_issues,
                              datadog, linear_issues)
    pending_risky_prs(pulls, commits)

    write_jsonl(DATA / "github" / "commits.jsonl", commits)
    write_jsonl(DATA / "github" / "pulls.jsonl", pulls)
    write_jsonl(DATA / "sentry" / "events.jsonl", sentry_events)
    write_jsonl(DATA / "sentry" / "issues.jsonl", sentry_issues)
    write_jsonl(DATA / "datadog" / "metrics.jsonl", datadog)
    write_jsonl(DATA / "linear" / "issues.jsonl", linear_issues)
    write_jsonl(DATA / "stripe" / "charges.jsonl", stripe_charges)
    print("Done.")


if __name__ == "__main__":
    main()
