import { createHash, timingSafeEqual } from "node:crypto";
import type { Route } from "../types.ts";

export interface RtspAuthDeps {
  verify(username: string, secret: string): Promise<boolean>;
  externalEnabled(): boolean;
}

export interface InternalCredentials {
  username: string;
  secret: string;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const text = (status: number) => new Response(null, { status });

export function buildRtspAuthRoute(internal: InternalCredentials, deps: RtspAuthDeps): Route {
  return {
    method: "POST",
    path: "/internal/rtsp-auth",
    access: "internal",
    async handler({ req }) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return text(400);
      }
      if (typeof body !== "object" || body === null) return text(400);
      const { user, password, action } = body as Record<string, unknown>;
      const username = typeof user === "string" ? user : "";
      const secret = typeof password === "string" ? password : "";

      // 兩個都比對完才判斷，避免因短路洩漏哪一個有對
      const userMatches = sameSecret(username, internal.username);
      const secretMatches = sameSecret(secret, internal.secret);
      const isInternal = userMatches && secretMatches;

      if (action !== "read") return text(403);
      if (isInternal) return text(200);
      if (!deps.externalEnabled()) return text(403);
      if (username === "") return text(401);
      return (await deps.verify(username, secret)) ? text(200) : text(401);
    },
  };
}
