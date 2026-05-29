import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";

/**
 * Streams the agent's events to the client as Server-Sent Events.
 * Each event is one line: `data: {...JSON...}\n\n`.
 */
export async function POST(req: NextRequest) {
  const { question } = await req.json();
  if (!question || typeof question !== "string") {
    return new Response(JSON.stringify({ error: "question required" }), { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const ev of runAgent(question)) {
          send(ev);
        }
      } catch (e) {
        send({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
