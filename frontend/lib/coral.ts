import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";

const exec = promisify(execFile);

/** Where the YAML manifests live, relative to repo root. */
const MANIFEST_DIR = resolve(process.cwd(), "..", "coral", "manifests");

/**
 * Run a SQL query against the local Coral runtime.
 * SELECT/WITH only.
 */
export async function coralSql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const trimmed = sql.trim();
  if (!/^(WITH|SELECT)\b/i.test(trimmed)) {
    throw new Error("Only SELECT/WITH queries are permitted.");
  }
  const { stdout } = await exec("coral", ["sql", "--format", "json", trimmed], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout) as T[];
}

/** List every source the agent could connect to + which are already connected. */
export async function listAvailableSources(): Promise<
  { name: string; description: string; status: "connected" | "available" }[]
> {
  const installed = await listInstalledSources();
  const installedSet = new Set(installed.map((s) => s.name));
  let manifestFiles: string[] = [];
  try {
    manifestFiles = (await readdir(MANIFEST_DIR)).filter((f) => f.endsWith(".yaml"));
  } catch {
    manifestFiles = [];
  }

  const out: { name: string; description: string; status: "connected" | "available" }[] = [];
  for (const file of manifestFiles) {
    const name = basename(file, ".yaml");
    const description = await readManifestSummary(join(MANIFEST_DIR, file));
    out.push({
      name,
      description,
      status: installedSet.has(name) ? "connected" : "available",
    });
  }
  // Include any installed sources that don't have a manifest on disk
  for (const s of installed) {
    if (!out.some((o) => o.name === s.name)) {
      out.push({ name: s.name, description: "(externally installed source)", status: "connected" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstalledSources(): Promise<{ name: string; tables: number }[]> {
  try {
    const rows = await coralSql<{ schema_name: string; n: string }>(
      `SELECT schema_name, CAST(COUNT(*) AS VARCHAR) AS n
       FROM coral.tables
       WHERE schema_name NOT IN ('coral', 'information_schema')
       GROUP BY schema_name`,
    );
    return rows.map((r) => ({ name: r.schema_name, tables: Number(r.n) }));
  } catch {
    return [];
  }
}

/** Reads the first `description:` field from a Coral manifest YAML, or falls
 *  back to a one-line summary of the source name. */
async function readManifestSummary(path: string): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    // Look for the top-level table descriptions
    const matches = raw.matchAll(/description:\s*(.+)$/gm);
    const lines = Array.from(matches).map((m) => m[1].trim().replace(/^["']|["']$/g, ""));
    if (lines.length > 0) return lines.join(" · ");
    return "Coral source";
  } catch {
    return "Coral source";
  }
}

/** Install one source by running `coral source add --file <manifest>.yaml`. */
export async function connectSource(
  name: string,
): Promise<{ ok: true; tables: string[] } | { ok: false; error: string }> {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "");
  const file = join(MANIFEST_DIR, `${safe}.yaml`);
  try {
    await readFile(file, "utf8");
  } catch {
    return { ok: false, error: `no manifest found for source '${safe}'` };
  }
  try {
    await exec("coral", ["source", "add", "--file", file], { timeout: 30_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already (registered|exists)/i.test(msg)) {
      return { ok: true, tables: await tablesFor(safe) };
    }
    return { ok: false, error: msg };
  }
  return { ok: true, tables: await tablesFor(safe) };
}

async function tablesFor(source: string): Promise<string[]> {
  try {
    const rows = await coralSql<{ table_name: string }>(
      `SELECT table_name FROM coral.tables WHERE schema_name = '${source.replace(/'/g, "''")}' ORDER BY 1`,
    );
    return rows.map((r) => r.table_name);
  } catch {
    return [];
  }
}

/** Return the schema (tables + columns + types) for one connected source. */
export async function describeCoralSource(
  source: string,
): Promise<{ table: string; columns: { name: string; type: string }[] }[]> {
  const rows = await coralSql<{
    table_name: string;
    column_name: string;
    data_type: string;
    ordinal_position: number;
  }>(
    `SELECT table_name, column_name, data_type, ordinal_position
     FROM coral.columns
     WHERE schema_name = '${source.replace(/'/g, "''")}'
     ORDER BY table_name, ordinal_position`,
  );
  const by = new Map<string, { name: string; type: string }[]>();
  for (const r of rows) {
    if (!by.has(r.table_name)) by.set(r.table_name, []);
    by.get(r.table_name)!.push({ name: r.column_name, type: r.data_type });
  }
  return Array.from(by, ([table, columns]) => ({ table, columns }));
}
