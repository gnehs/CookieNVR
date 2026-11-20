import type { ErrorDto } from "../api-types.ts";
import { msg, zh, type Msg } from "../messages/index.ts";
import { HttpError } from "./errors.ts";

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}

export function errorBody(m: Msg): ErrorDto {
  return { error: zh(m), code: m.code, ...(m.params === undefined ? {} : { params: m.params }) } as ErrorDto;
}

export function errorResponse(status: number, m: Msg, headers?: HeadersInit): Response {
  return Response.json(errorBody(m), { status, headers });
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.msg, err.headers);
  console.error("[http] unhandled error", err);
  return errorResponse(500, msg("internal"));
}
