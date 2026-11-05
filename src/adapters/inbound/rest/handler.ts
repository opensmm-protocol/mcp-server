/**
 * OpenSMM REST adapter (spec/v0 §2). Thin: validates input, calls core commands,
 * maps canonical errors to HTTP statuses. No business logic here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { OpenSmmCore } from "../../../core/core.ts";
import { OpenSmmError, toErrorBody } from "../../../core/errors.ts";

const PLATFORM_VALUES = ["telegram", "instagram", "youtube", "tiktok", "x", "vk", "other"] as const;
const OBJECTIVE_VALUES = ["followers", "members", "likes", "views", "reactions", "comments", "other"] as const;

const createQuoteSchema = z.object({
  serviceId: z.string().regex(/^osmm_svc_/),
  quantity: z.number().int().min(1),
  link: z.string().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const createOrderSchema = z.object({
  quoteId: z.string().regex(/^osmm_quote_/),
  link: z.string().min(1),
  quantity: z.number().int().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  clientReference: z.string().min(1).max(128).optional(),
});

const registerProviderSchema = z.object({
  adapter: z.enum(["smm-v2", "rest-v1"]),
  endpoint: z.string().min(1),
  apiKey: z.string().min(1),
  profile: z.string().min(1).optional(),
  displayName: z.string().min(1).max(80).optional(),
  publiclyListed: z.boolean().optional(),
  payoutAddress: z.string().min(1).optional(),
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Open read API: browser agents and the opensmm.dev site fetch cross-origin.
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new OpenSmmError("VALIDATION_FAILED", "request body is not valid JSON");
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new OpenSmmError("VALIDATION_FAILED", "request failed validation", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export function createRestHandler(
  core: OpenSmmCore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, idempotency-key",
        });
        res.end();
        return;
      }

      if (method === "GET" && path === "/v0/capabilities") {
        sendJson(res, 200, core.getCapabilities());
        return;
      }

      if (method === "GET" && path === "/v0/providers") {
        sendJson(res, 200, await core.listProviders());
        return;
      }

      if (method === "POST" && path === "/v0/providers") {
        const input = validate(registerProviderSchema, await readJsonBody(req));
        // The response never echoes apiKey back (spec/v0 §10).
        sendJson(res, 201, await core.registerProvider(input));
        return;
      }

      if (method === "GET" && path === "/v0/services") {
        const platform = url.searchParams.get("platform") ?? undefined;
        const objective = url.searchParams.get("objective") ?? undefined;
        if (platform && !PLATFORM_VALUES.includes(platform as (typeof PLATFORM_VALUES)[number])) {
          throw new OpenSmmError("VALIDATION_FAILED", `unknown platform: ${platform}`);
        }
        if (objective && !OBJECTIVE_VALUES.includes(objective as (typeof OBJECTIVE_VALUES)[number])) {
          throw new OpenSmmError("VALIDATION_FAILED", `unknown objective: ${objective}`);
        }
        const result = core.searchServices({
          query: url.searchParams.get("query") ?? undefined,
          platform: platform as (typeof PLATFORM_VALUES)[number] | undefined,
          objective: objective as (typeof OBJECTIVE_VALUES)[number] | undefined,
        });
        sendJson(res, 200, result);
        return;
      }

      let m = /^\/v0\/services\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        sendJson(res, 200, core.getService(decodeURIComponent(m[1]!)));
        return;
      }

      if (method === "POST" && path === "/v0/quotes") {
        const input = validate(createQuoteSchema, await readJsonBody(req));
        sendJson(res, 201, core.getQuote(input));
        return;
      }

      if (method === "POST" && path === "/v0/orders") {
        const body = validate(createOrderSchema, await readJsonBody(req));
        const idempotencyKey = req.headers["idempotency-key"];
        const clientReference =
          body.clientReference ??
          (typeof idempotencyKey === "string" && idempotencyKey ? idempotencyKey : undefined);
        if (!clientReference) {
          throw new OpenSmmError(
            "VALIDATION_FAILED",
            "clientReference body field or Idempotency-Key header is required",
          );
        }
        const { order, replayed } = await core.createOrder({ ...body, clientReference });
        // 402 while payment is outstanding — the Order body travels with it (spec §7).
        const status = replayed || order.paymentStatus !== "REQUIRES_PAYMENT" ? 200 : 402;
        sendJson(res, status, order);
        return;
      }

      m = /^\/v0\/orders\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        sendJson(res, 200, await core.getOrder(decodeURIComponent(m[1]!)));
        return;
      }

      m = /^\/v0\/orders\/([^/]+)\/cancel$/.exec(path);
      if (method === "POST" && m) {
        sendJson(res, 200, await core.cancelOrder(decodeURIComponent(m[1]!)));
        return;
      }

      m = /^\/v0\/orders\/([^/]+)\/refill$/.exec(path);
      if (method === "POST" && m) {
        sendJson(res, 201, await core.requestRefill(decodeURIComponent(m[1]!)));
        return;
      }

      m = /^\/v0\/payments\/([^/]+)\/settle$/.exec(path);
      if (method === "POST" && m) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const settleMethod = body.method === undefined ? undefined : String(body.method);
        if (
          settleMethod !== undefined &&
          !["x402", "ton", "cryptobot", "mock"].includes(settleMethod)
        ) {
          throw new OpenSmmError("VALIDATION_FAILED", `unknown payment method: ${settleMethod}`);
        }
        sendJson(
          res,
          200,
          await core.settlePayment(decodeURIComponent(m[1]!), {
            method: settleMethod as "x402" | "ton" | "cryptobot" | "mock" | undefined,
            proof: body.proof,
          }),
        );
        return;
      }

      throw new OpenSmmError("NOT_FOUND", `${method} ${path} is not part of OpenSMM /v0`);
    } catch (err) {
      const { httpStatus, body } = toErrorBody(err);
      sendJson(res, httpStatus, body);
    }
  };
}
