import Anthropic from "@anthropic-ai/sdk";
import { coralSql, listAvailableSources, connectSource, describeCoralSource } from "./coral";

const SYSTEM = `You are Spyglass, an autonomous engineering-investigation agent.

You have access to Coral — an open-source SQL surface — but at the start of an
investigation NOTHING is connected. You discover what data sources you could
connect to, decide which ones you actually need, connect them, then query.

Your tools, in the order you'll typically use them:
  1. list_available_sources()              — every source you could connect
  2. connect_source(name)                   — actually wire one up
  3. describe_source(source)                — read its schema
  4. run_coral_sql(sql)                     — query

INVESTIGATIVE STYLE — focused and iterative, never batched.
  - Always START by calling list_available_sources so you know what's possible.
  - Then CHOOSE the minimum set that can answer the user's question — and say
    out loud why you chose each one (one short sentence per source).
    Example: "Revenue lives in Stripe, root cause likely in Sentry or GitHub.
              Skipping Datadog and Linear for now."
  - Connect ONLY those sources. Don't connect more "just in case."
  - After connecting a source, describe it and query it before moving on.
  - If a query opens a new angle, you may connect another source mid-flight.

SQL rules:
  - Timestamps are stored as Utf8 ISO8601 strings. Compare with string literals
    like '2026-04-18T14:00:00Z'.
  - DataFusion: use to_char/CAST AS TIMESTAMP for date math. No strftime, no
    correlated subqueries, no LATERAL.
  - Cross-source JOIN is Coral's killer feature — use it whenever you have
    connected the sources to JOIN.
  - Always LIMIT to <= 50 rows unless aggregating.

Answer style:
  - Lead with the apparent root cause as a headline.
  - Cite specific values (PR numbers, timestamps, dollar figures) from your
    queries — never invent.
  - Use a short timeline table when there are 3+ chronological events.
  - Be concise. Engineers read this during an incident.
`;

export type AgentEvent =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; tool: string; preview: string; ok: boolean }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string };

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_available_sources",
    description:
      "List every data source the agent COULD connect to, plus whether each is already connected. Always call this FIRST so you can decide which sources to actually wire up. Returns an array of {name, description, status}.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "connect_source",
    description:
      "Connect (install) one Coral source from its manifest so you can query it. Pass the source 'name' from list_available_sources. Returns {ok, tables}. Idempotent — already-connected sources just succeed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The source name (e.g. reefline_stripe)." },
      },
      required: ["name"],
    },
  },
  {
    name: "describe_source",
    description:
      "Return the schema (tables + columns + types) of one connected source. Source must be connected first.",
    input_schema: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
    },
  },
  {
    name: "run_coral_sql",
    description:
      "Execute one SELECT/WITH query against Coral. JOINs across connected sources are supported.",
    input_schema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
  },
];

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to frontend/.env.local.");
    }
    client = new Anthropic();
  }
  return client;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    if (name === "list_available_sources") {
      return { ok: true, result: await listAvailableSources() };
    }
    if (name === "connect_source") {
      const src = String(input.name ?? "");
      if (!src) return { ok: false, error: "Missing 'name' argument." };
      const out = await connectSource(src);
      if (!out.ok) return { ok: false, error: out.error };
      return { ok: true, result: { connected: src, tables: out.tables } };
    }
    if (name === "describe_source") {
      const source = String(input.source ?? "");
      if (!source) return { ok: false, error: "Missing 'source' argument." };
      return { ok: true, result: await describeCoralSource(source) };
    }
    if (name === "run_coral_sql") {
      const sql = String(input.sql ?? "");
      if (!sql) return { ok: false, error: "Missing 'sql' argument." };
      const rows = await coralSql(sql);
      return { ok: true, result: rows.slice(0, 50) };
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Agent loop with true token streaming. Text deltas stream as Claude generates
 * them; tool calls emit when Claude finishes generating their input JSON.
 */
export async function* runAgent(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  const MAX_STEPS = 12;

  for (let step = 0; step < MAX_STEPS; step++) {
    const blocks: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; inputBuf: string }
    > = [];
    let stopReason: Anthropic.Messages.Message["stop_reason"] | null = null;

    try {
      const stream = getClient().messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        temperature: 0.3,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const cb = event.content_block;
          if (cb.type === "text") blocks[event.index] = { type: "text", text: "" };
          else if (cb.type === "tool_use")
            blocks[event.index] = { type: "tool_use", id: cb.id, name: cb.name, inputBuf: "" };
        } else if (event.type === "content_block_delta") {
          const b = blocks[event.index];
          if (!b) continue;
          if (event.delta.type === "text_delta" && b.type === "text") {
            b.text += event.delta.text;
            yield { kind: "thought", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta" && b.type === "tool_use") {
            b.inputBuf += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const b = blocks[event.index];
          if (b?.type === "tool_use") {
            let parsed: Record<string, unknown> = {};
            try { parsed = b.inputBuf ? JSON.parse(b.inputBuf) : {}; } catch {}
            yield { kind: "tool_call", tool: b.name, input: parsed };
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }
    } catch (e) {
      yield { kind: "error", text: e instanceof Error ? e.message : String(e) };
      return;
    }

    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      const finalText = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      yield { kind: "answer", text: finalText || "(no answer produced)" };
      return;
    }

    if (stopReason !== "tool_use") {
      yield { kind: "error", text: `Unexpected stop_reason: ${stopReason}` };
      return;
    }

    const toolUseBlocks = blocks.filter(
      (b): b is { type: "tool_use"; id: string; name: string; inputBuf: string } =>
        b.type === "tool_use",
    );
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    const assistantContent: Anthropic.Messages.ContentBlockParam[] = blocks.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      let input: Record<string, unknown> = {};
      try { input = b.inputBuf ? JSON.parse(b.inputBuf) : {}; } catch {}
      return { type: "tool_use", id: b.id, name: b.name, input };
    });

    for (const tu of toolUseBlocks) {
      let input: Record<string, unknown> = {};
      try { input = tu.inputBuf ? JSON.parse(tu.inputBuf) : {}; } catch {}
      const out = await executeTool(tu.name, input);
      yield {
        kind: "tool_result",
        tool: tu.name,
        ok: out.ok,
        preview: out.ok ? previewResult(out.result) : `error: ${out.error}`,
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: out.ok ? JSON.stringify(out.result) : `error: ${out.error}`,
        is_error: !out.ok,
      });
    }

    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: toolResults });
  }

  yield { kind: "error", text: `Hit step cap of ${MAX_STEPS} without a final answer.` };
}

function previewResult(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (no rows)";
    if (value.length === 1) return `1 row · ${JSON.stringify(value[0]).slice(0, 200)}…`;
    return `${value.length} rows · first: ${JSON.stringify(value[0]).slice(0, 160)}…`;
  }
  if (value && typeof value === "object" && "connected" in (value as object)) {
    const v = value as { connected: string; tables: string[] };
    return `connected ${v.connected} · ${v.tables.length} table${v.tables.length === 1 ? "" : "s"}: ${v.tables.join(", ")}`;
  }
  return JSON.stringify(value).slice(0, 200);
}
