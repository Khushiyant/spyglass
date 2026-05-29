"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type AgentEvent =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; tool: string; preview: string; ok: boolean }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string };

type Investigation = {
  question: string;
  events: AgentEvent[];
  live: boolean;
  startedAt: number;
};

const SUGGESTED = [
  "Why did Stripe revenue look bad on April 18?",
  "Which open PR is most likely to break checkout this week?",
  "What broke last in the auth-service — and how badly?",
  "Show me the worst incidents this quarter, ranked by user impact.",
];

const SHAPES = ["circle", "triangle", "diamond", "square", "plus"] as const;
type Shape = typeof SHAPES[number];

export default function Page() {
  const [inv, setInv] = useState<Investigation | null>(null);
  const [q, setQ] = useState("");
  const [streaming, setStreaming] = useState(false);

  async function scope(question: string) {
    if (!question.trim() || streaming) return;
    setStreaming(true);
    setInv({ question, events: [], live: true, startedAt: Date.now() });
    setQ("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text();
        appendEvent({ kind: "error", text: body || `HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              appendEvent(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
      }
    } catch (e) {
      appendEvent({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setStreaming(false);
      setInv((i) => (i ? { ...i, live: false } : i));
    }
  }

  function appendEvent(ev: AgentEvent) {
    setInv((i) => {
      if (!i) return i;
      // Merge consecutive "thought" deltas into the same event so the UI
      // shows tokens streaming character-by-character into one paragraph.
      const last = i.events[i.events.length - 1];
      if (ev.kind === "thought" && last?.kind === "thought") {
        const merged: AgentEvent = { kind: "thought", text: last.text + ev.text };
        return { ...i, events: [...i.events.slice(0, -1), merged] };
      }
      return { ...i, events: [...i.events, ev] };
    });
  }

  function reset() {
    setInv(null);
    setQ("");
  }

  return (
    <main className="max-w-[1400px] mx-auto px-8 py-8">
      <TopBar onReset={inv ? reset : undefined} streaming={streaming} />

      {!inv ? (
        <Landing onPick={scope} q={q} setQ={setQ} streaming={streaming} />
      ) : (
        <ScopeView inv={inv} streaming={streaming} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ chrome */

function TopBar({ onReset, streaming }: { onReset?: () => void; streaming: boolean }) {
  return (
    <header className="flex items-center justify-between mb-8">
      <div className="flex items-center gap-3">
        <div className="kicker">spyglass</div>
        <div className="text-[10px] mono text-[var(--ink-dim)] tracking-widest">
          / Coral-driven engineering agent
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 mono text-[10px] uppercase tracking-widest ${
            streaming ? "text-[var(--accent)]" : "text-[var(--ink-dim)]"
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              streaming ? "bg-[var(--accent)] animate-pulse" : "bg-[var(--ink-dim)]"
            }`}
          />
          {streaming ? "scanning" : "standing by"}
        </span>
        {onReset && (
          <button onClick={onReset} className="btn mono text-[11px]">
            new scope
          </button>
        )}
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------- landing */

function Landing({
  onPick,
  q,
  setQ,
  streaming,
}: {
  onPick: (q: string) => void;
  q: string;
  setQ: (q: string) => void;
  streaming: boolean;
}) {
  return (
    <div className="max-w-3xl mx-auto pt-16 pb-24 text-center">
      <h1 className="sketch text-8xl underline-sketch inline-block">Spyglass</h1>
      <p className="sketch text-3xl mt-6 text-[var(--ink-soft)]">
        point the scope. find the truth.
      </p>
      <p className="text-sm text-[var(--ink-dim)] mt-3 max-w-xl mx-auto leading-relaxed">
        an autonomous agent that discovers your data sources at runtime, writes
        cross-source SQL against Coral, and narrates what it finds — no
        configuration, no pre-built dashboards.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onPick(q);
        }}
        className="mt-14"
      >
        <div className="card p-3 flex gap-3 items-stretch text-left">
          <div className="flex items-center pl-3 text-[var(--ink-dim)] mono text-xs uppercase tracking-widest">
            scope ▷
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ask anything about what's happening in your stack…"
            className="flex-1 px-2 py-3 text-base border-0 outline-none bg-transparent"
            autoFocus
          />
          <button className="btn btn-primary" disabled={streaming || !q.trim()}>
            engage →
          </button>
        </div>
      </form>

      <div className="mt-10 text-left">
        <div className="kicker mb-3">probe templates</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {SUGGESTED.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="card text-left px-4 py-3 hover:bg-[var(--paper)] transition"
            >
              <div className="text-sm">{s}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ scope view */

const SOURCE_SHAPE: Record<string, Shape> = {
  reefline_github: "circle",
  reefline_sentry: "triangle",
  reefline_datadog: "diamond",
  reefline_linear: "square",
  reefline_stripe: "plus",
};

const SOURCE_LABEL: Record<string, string> = {
  reefline_github: "github",
  reefline_sentry: "sentry",
  reefline_datadog: "datadog",
  reefline_linear: "linear",
  reefline_stripe: "stripe",
};

type SourceState = {
  name: string;
  shape: Shape;
  label: string;
  /** the agent has connected this source via connect_source */
  connected: boolean;
  /** the agent has called describe_source on it */
  described: boolean;
  queryCount: number;
  /** monotonically updated when the agent touches this source */
  lastTouched: number;
};

function deriveState(events: AgentEvent[]): {
  sources: SourceState[];
  probes: { tool: string; sql?: string; sources: string[]; result?: string; ok?: boolean }[];
  thoughts: string[];
  answer: string | null;
  error: string | null;
} {
  const sourceMap = new Map<string, SourceState>();
  const probes: { tool: string; sql?: string; sources: string[]; result?: string; ok?: boolean }[] = [];
  const thoughts: string[] = [];
  let answer: string | null = null;
  let error: string | null = null;
  let tick = 0;

  const touch = (name: string, kind: "connect" | "describe" | "query") => {
    if (!sourceMap.has(name)) {
      sourceMap.set(name, {
        name,
        shape: SOURCE_SHAPE[name] ?? "circle",
        label: SOURCE_LABEL[name] ?? name.replace(/^reefline_/, ""),
        connected: kind === "connect",
        described: false,
        queryCount: 0,
        lastTouched: tick++,
      });
    } else {
      const s = sourceMap.get(name)!;
      s.lastTouched = tick++;
      if (kind === "connect") s.connected = true;
    }
  };

  for (const ev of events) {
    if (ev.kind === "thought") thoughts.push(ev.text);
    if (ev.kind === "answer") answer = ev.text;
    if (ev.kind === "error") error = ev.text;
    if (ev.kind === "tool_call") {
      if (ev.tool === "connect_source") {
        const src = String(ev.input.name ?? "");
        if (src) touch(src, "connect");
        probes.push({ tool: "connect_source", sources: src ? [src] : [] });
      } else if (ev.tool === "describe_source") {
        const src = String(ev.input.source ?? "");
        if (src) {
          touch(src, "describe");
          sourceMap.get(src)!.described = true;
        }
        probes.push({ tool: "describe_source", sources: src ? [src] : [] });
      } else if (ev.tool === "run_coral_sql") {
        const sql = String(ev.input.sql ?? "");
        const hit = matchSources(sql);
        for (const s of hit) {
          touch(s, "query");
          sourceMap.get(s)!.queryCount++;
        }
        probes.push({ tool: "run_coral_sql", sql, sources: hit });
      } else if (ev.tool === "list_available_sources") {
        probes.push({ tool: "list_available_sources", sources: [] });
      }
    }
    if (ev.kind === "tool_result") {
      const last = probes[probes.length - 1];
      if (last) {
        last.result = ev.preview;
        last.ok = ev.ok;
      }
    }
  }
  // Note: we deliberately do NOT pre-populate the canvas from
  // list_coral_sources. Source nodes only appear once the agent actually
  // engages with them (describes or queries) — that's what makes the canvas
  // feel discovered, not pre-built.

  return {
    sources: Array.from(sourceMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    probes,
    thoughts,
    answer,
    error,
  };
}

function matchSources(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(reefline_[a-z]+)\./g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(sql)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function ScopeView({ inv, streaming }: { inv: Investigation; streaming: boolean }) {
  const state = useMemo(() => deriveState(inv.events), [inv.events]);
  const probeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    probeRef.current?.scrollTo({ top: probeRef.current.scrollHeight, behavior: "smooth" });
  }, [inv.events.length]);

  return (
    <div className="space-y-6">
      {/* current scope banner */}
      <div className="card p-5">
        <div className="flex items-baseline gap-3 flex-wrap">
          <div className="kicker">current scope</div>
          <div className="text-[10px] mono text-[var(--ink-dim)]">
            {inv.events.length} events · {state.probes.length} probes ·{" "}
            {state.probes.filter((p) => p.tool === "run_coral_sql").length} SQL
          </div>
        </div>
        <div className="sketch text-3xl mt-2">{inv.question}</div>
      </div>

      {/* main canvas + reading panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6">
        <Canvas sources={state.sources} activeProbe={state.probes[state.probes.length - 1]} streaming={streaming} />
        <Reading answer={state.answer} thoughts={state.thoughts} error={state.error} streaming={streaming} />
      </div>

      {/* probe log */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--ink)] flex justify-between items-center">
          <div className="kicker">probes</div>
          <div className="mono text-[10px] text-[var(--ink-dim)]">live transcript</div>
        </div>
        <div ref={probeRef} className="max-h-[280px] overflow-y-auto p-5 space-y-3">
          {state.probes.length === 0 && (
            <div className="text-[var(--ink-dim)] text-sm italic">waiting for the agent…</div>
          )}
          {state.probes.map((p, i) => (
            <ProbeRow key={i} probe={p} idx={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ canvas */

function Canvas({
  sources,
  activeProbe,
  streaming,
}: {
  sources: SourceState[];
  activeProbe?: { tool: string; sources: string[] };
  streaming: boolean;
}) {
  const W = 700;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2 + 20;
  const radius = 170;

  const positions = useMemo(() => {
    return sources.map((s, i) => {
      const angle = (-Math.PI / 2) + (i * (2 * Math.PI)) / Math.max(sources.length, 1);
      return {
        ...s,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  }, [sources.length, cx, cy]);

  const activeSet = new Set(activeProbe?.sources ?? []);
  const activeQuery = activeProbe?.tool === "run_coral_sql";

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--ink)] flex justify-between items-center">
        <div className="kicker">investigation canvas</div>
        <div className="mono text-[10px] text-[var(--ink-dim)]">
          {sources.length} source{sources.length === 1 ? "" : "s"} discovered ·{" "}
          {sources.filter((s) => s.described).length} described
        </div>
      </div>
      <div className="p-4 relative bg-[var(--paper)]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ display: "block" }}>
          {/* Faint reference circle (the spyglass dial) */}
          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#0a0a0a" strokeOpacity={0.08} strokeDasharray="3 4" />
          <circle cx={cx} cy={cy} r={radius - 14} fill="none" stroke="#0a0a0a" strokeOpacity={0.06} />

          {/* Hub */}
          <Hub x={cx} y={cy} streaming={streaming} />

          {/* Lines (drawn from hub to each source, brighter for active) */}
          {positions.map((p) => {
            const active = activeSet.has(p.name) && activeQuery;
            return (
              <line
                key={`l-${p.name}`}
                x1={cx}
                y1={cy}
                x2={p.x}
                y2={p.y}
                stroke={active ? "#ff5a36" : "#0a0a0a"}
                strokeOpacity={active ? 1 : 0.18}
                strokeWidth={active ? 2.5 : 1.5}
                strokeDasharray={active ? undefined : "4 4"}
              />
            );
          })}

          {/* Source nodes */}
          {positions.map((p) => (
            <SourceNode key={p.name} pos={p} active={activeSet.has(p.name)} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Hub({ x, y, streaming }: { x: number; y: number; streaming: boolean }) {
  return (
    <g>
      {streaming && (
        <>
          <circle cx={x} cy={y} r={28} fill="none" stroke="#ff5a36" strokeWidth={2} opacity={0.5}>
            <animate attributeName="r" from="28" to="48" dur="1.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.55" to="0" dur="1.4s" repeatCount="indefinite" />
          </circle>
          <circle cx={x} cy={y} r={28} fill="none" stroke="#ff5a36" strokeWidth={2} opacity={0.3}>
            <animate attributeName="r" from="28" to="60" dur="1.4s" begin="0.7s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.4" to="0" dur="1.4s" begin="0.7s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      <circle cx={x} cy={y} r={26} fill="#fff" stroke="#0a0a0a" strokeWidth={2.5} />
      <text x={x} y={y + 8} textAnchor="middle" fontFamily='"Caveat", cursive' fontSize={24} fontWeight={700} fill="#0a0a0a">
        ?
      </text>
    </g>
  );
}

function SourceNode({ pos, active }: { pos: SourceState & { x: number; y: number }; active: boolean }) {
  const fill = active ? "#0a0a0a" : pos.described ? "#fff" : "#fff";
  const stroke = "#0a0a0a";
  const dim = pos.lastTouched < 0 ? 0.35 : 1;
  return (
    <g opacity={dim}>
      {active && (
        <circle cx={pos.x} cy={pos.y} r={26} fill="none" stroke="#ff5a36" strokeWidth={2}>
          <animate attributeName="r" from="26" to="42" dur="1.1s" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.7" to="0" dur="1.1s" repeatCount="indefinite" />
        </circle>
      )}
      <ShapeIcon shape={pos.shape} cx={pos.x} cy={pos.y} fill={fill} stroke={stroke} active={active} />
      <text
        x={pos.x}
        y={pos.y + 46}
        textAnchor="middle"
        fontFamily='"JetBrains Mono", monospace'
        fontSize={13}
        letterSpacing={1.5}
        fill={stroke}
      >
        {pos.label.toUpperCase()}
      </text>
      {pos.queryCount > 0 && (
        <g transform={`translate(${pos.x + 22}, ${pos.y - 22})`}>
          <circle r={11} fill="#ff5a36" stroke="#0a0a0a" strokeWidth={1.5} />
          <text textAnchor="middle" y={4} fontFamily='"JetBrains Mono", monospace' fontSize={11} fontWeight={700} fill="#fff">
            {pos.queryCount}
          </text>
        </g>
      )}
    </g>
  );
}

function ShapeIcon({
  shape,
  cx,
  cy,
  fill,
  stroke,
  active,
}: {
  shape: Shape;
  cx: number;
  cy: number;
  fill: string;
  stroke: string;
  active: boolean;
}) {
  const sw = 2.5;
  const r = 18;
  switch (shape) {
    case "circle":
      return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "triangle":
      return (
        <path
          d={`M ${cx} ${cy - r - 2} L ${cx + r} ${cy + r - 4} L ${cx - r} ${cy + r - 4} Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      );
    case "square":
      return (
        <rect
          x={cx - r}
          y={cy - r}
          width={r * 2}
          height={r * 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
        />
      );
    case "diamond":
      return (
        <path
          d={`M ${cx} ${cy - r - 2} L ${cx + r + 2} ${cy} L ${cx} ${cy + r + 2} L ${cx - r - 2} ${cy} Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      );
    case "plus":
      return (
        <g>
          <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} stroke={stroke} strokeWidth={sw} />
          <path
            d={`M ${cx} ${cy - 10} L ${cx} ${cy + 10} M ${cx - 10} ${cy} L ${cx + 10} ${cy}`}
            stroke={active ? "#fff" : stroke}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </g>
      );
  }
}

/* ------------------------------------------------------------ reading */

function Reading({
  answer,
  thoughts,
  error,
  streaming,
}: {
  answer: string | null;
  thoughts: string[];
  error: string | null;
  streaming: boolean;
}) {
  return (
    <div className="card p-0 overflow-hidden flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--ink)] flex items-center justify-between">
        <div className="kicker">reading</div>
        <div className="mono text-[10px] text-[var(--ink-dim)]">
          {answer ? "verdict locked" : streaming ? "assembling…" : "waiting"}
        </div>
      </div>

      <div className="p-5 flex-1 overflow-y-auto max-h-[600px]">
        {error && (
          <div className="card p-3 text-sm text-[var(--accent)] border-[var(--accent)] mb-3">⚠ {error}</div>
        )}

        {thoughts.length > 0 && !answer && (
          <div className="space-y-3 mb-4">
            {thoughts.map((t, i) => (
              <div key={i} className="text-[12px] mono text-[var(--ink-dim)] italic leading-relaxed">
                ↪ {t.slice(0, 280)}
                {t.length > 280 ? "…" : ""}
              </div>
            ))}
          </div>
        )}

        {answer ? (
          <div className="prose-spyglass">
            <Markdown text={answer} />
          </div>
        ) : !error && (
          <ScanLoader />
        )}
      </div>
    </div>
  );
}

function ScanLoader() {
  return (
    <div className="flex items-center gap-3 text-[var(--ink-dim)] text-sm">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" />
        <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" style={{ animationDelay: "0.15s" }} />
        <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-pulse" style={{ animationDelay: "0.3s" }} />
      </div>
      <span className="mono text-[11px] uppercase tracking-widest">scope is reading…</span>
    </div>
  );
}

/** very small markdown — bold, headings, line breaks. agent output is structured. */
function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="text-sm leading-relaxed">
      {lines.map((ln, i) => {
        if (ln.startsWith("### ")) return <h3 key={i} className="text-base font-semibold mt-3 mb-1">{ln.slice(4)}</h3>;
        if (ln.startsWith("## ")) return <h2 key={i} className="sketch text-2xl mt-4 mb-2">{ln.slice(3)}</h2>;
        if (ln.startsWith("# ")) return <h1 key={i} className="sketch text-3xl mt-4 mb-2">{ln.slice(2)}</h1>;
        if (/^\s*\|/.test(ln)) {
          return <div key={i} className="mono text-[11px] whitespace-pre text-[var(--ink-soft)]">{ln}</div>;
        }
        if (ln.trim() === "---") return <hr key={i} className="my-3 border-[var(--ink)]/30" />;
        if (ln.trim() === "") return <div key={i} className="h-2" />;
        return (
          <p key={i} className="mb-1" dangerouslySetInnerHTML={{ __html: renderInline(ln) }} />
        );
      })}
    </div>
  );
}

function renderInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="mono text-[12px] px-1 py-0.5 bg-[var(--paper)] border border-[var(--ink)]/40">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/* ------------------------------------------------------------ probe row */

function ProbeRow({ probe, idx }: { probe: { tool: string; sql?: string; sources: string[]; result?: string; ok?: boolean }; idx: number }) {
  return (
    <div>
      <div className="flex items-center gap-3 text-[11px] mono text-[var(--ink-dim)] uppercase tracking-widest">
        <span className="text-[var(--ink)]">▷ {String(idx + 1).padStart(2, "0")}</span>
        <span>{probe.tool.replace(/_/g, " ")}</span>
        {probe.sources.length > 0 && (
          <span className="text-[var(--ink)]">→ {probe.sources.map((s) => SOURCE_LABEL[s] ?? s).join(" + ")}</span>
        )}
        {probe.result && (
          <span className={`ml-auto ${probe.ok === false ? "text-[var(--accent)]" : ""}`}>
            {probe.ok === false ? "✗" : "←"} {probe.result.length > 80 ? probe.result.slice(0, 80) + "…" : probe.result}
          </span>
        )}
      </div>
      {probe.sql && (
        <pre className="mono text-[11px] mt-1 ml-12 whitespace-pre-wrap text-[var(--ink-soft)] bg-[var(--paper)] p-2 border-l-2 border-[var(--ink)]/30">
{probe.sql.trim()}
        </pre>
      )}
    </div>
  );
}
