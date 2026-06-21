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
        // Forward the upgrade (incl. ?token= and the Phase-5 ?session=) to the DO
        // and return its 101 Response as-is. A 101 carries the webSocket; do NOT
        // add CORS headers.
        const wsToken = encodeURIComponent(url.searchParams.get("token") || "");
        const wsSession = encodeURIComponent(url.searchParams.get("session") || "");
        return await stub.fetch(`https://do/sync?token=${wsToken}&session=${wsSession}`, request);
      }

      // POST /api/maps/:id/links  — owner-only link management (Phase 4)
      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "maps" &&
        parts[3] === "links"
      ) {
        return await manageLinks(parts[2], request, env, cors);
      }

      // POST /api/maps/:id/access  — password gate (Phase 5). A non-owner
      // exchanges (token + optional password) for a short-lived session token.
      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "maps" &&
        parts[3] === "access"
      ) {
        return await accessMap(parts[2], request, env, cors);
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
    // shareTokens: raw editor/viewer secrets stored in the DO so the owner can
    // re-read/copy share links after a reload (the owner key stays hash-only).
    body: JSON.stringify({
      mapId,
      name,
      journeys,
      tokenHashes,
      shareTokens: { editor: tokens.editor, viewer: tokens.viewer },
    }),
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
  const session = url.searchParams.get("session");
  const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(mapId));
  const res = await stub.fetch(
    `https://do/doc?token=${encodeURIComponent(token || "")}&session=${encodeURIComponent(session || "")}`,
  );
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// POST /api/maps/:id/access — forward the password gate check to the DO and
// return its JSON (with CORS). The password travels in the POST body, never the
// URL. The DO resolves the role, verifies the password, and mints the session.
async function accessMap(
  mapId: string,
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const bodyText = await request.text();
  const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(mapId));
  const res = await stub.fetch("https://do/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// POST /api/maps/:id/links — forward the owner-only link-management request to
// the DO and return its JSON (with CORS). This is a normal JSON endpoint, not a
// WebSocket. The DO enforces the owner-only auth check.
async function manageLinks(
  mapId: string,
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const bodyText = await request.text();
  const stub = env.MAP_ROOM.get(env.MAP_ROOM.idFromName(mapId));
  const res = await stub.fetch("https://do/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
