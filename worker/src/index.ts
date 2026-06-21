// Worker router: REST endpoints for Lanescape collaborative sync. Resolves each
// map to its Durable Object and forwards. Phase 1 covers map creation + hydrate.

import { MapRoom } from "./MapRoom";
import {
  corsHeaders,
  errorJson,
  json,
  randomId,
  randomSecret,
  sha256Hex,
} from "./util";

export { MapRoom };

interface Env {
  MAP_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowed = new Set(
      (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","maps",":id"]

    try {
      // POST /api/maps  — enable sync, mint a new cloud map
      if (request.method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "maps") {
        return await createMap(request, env, cors);
      }

      // GET /api/maps/:id/sync  — WebSocket upgrade -> DO live channel
      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "maps" &&
        parts[3] === "sync" &&
        request.headers.get("Upgrade") === "websocket"
      ) {
        const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(parts[2]));
        // Forward the upgrade (incl. ?token=) to the DO and return its 101
        // Response as-is. A 101 carries the webSocket; do NOT add CORS headers.
        return await stub.fetch(`https://do/sync?token=${encodeURIComponent(url.searchParams.get("token") || "")}`, request);
      }

      // GET /api/maps/:id  — hydrate
      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "maps") {
        return await getMap(parts[2], url, env, cors);
      }

      return errorJson(404, "Not found", cors);
    } catch (err) {
      return errorJson(500, err instanceof Error ? err.message : "Internal error", cors);
    }
  },
};

async function createMap(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { journeys?: unknown; name?: string };
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "Invalid JSON body", cors);
  }
  const journeys = Array.isArray(body.journeys) ? body.journeys : [];
  const name = typeof body.name === "string" ? body.name : "Untitled";

  const mapId = `m_${randomId(24)}`;
  // Raw secrets are returned to the caller exactly once; only hashes are stored.
  const tokens = { owner: randomSecret(), editor: randomSecret(), viewer: randomSecret() };
  const tokenHashes = {
    owner: await sha256Hex(tokens.owner),
    editor: await sha256Hex(tokens.editor),
    viewer: await sha256Hex(tokens.viewer),
  };

  const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(mapId));
  const initRes = await stub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ mapId, name, journeys, tokenHashes }),
  });
  if (!initRes.ok) {
    return errorJson(initRes.status, "Could not create map", cors);
  }

  return json({ mapId, version: 1, tokens }, { status: 201 }, cors);
}

async function getMap(
  mapId: string,
  url: URL,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const token = url.searchParams.get("token");
  const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(mapId));
  const res = await stub.fetch(`https://do/doc?token=${encodeURIComponent(token || "")}`);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
