// Rate limiting example.
//
// /limited/*  — limited to 10 req/s per client IP. Returns 429 when exceeded.
// Anything else passes through to origin untouched.
//
// Key choice matters: always use a value that an attacker cannot enumerate
// to generate unlimited unique buckets (e.g. never use req.url directly,
// since query strings make every request unique and defeat the limit).
// Good keys: client IP, authenticated user ID, a normalised path prefix.

import { Request, onClientRequest, RateLimit } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  if (!req.path.startsWith("/limited/")) return;

  // register() is idempotent; the rps is fixed at the first call per name.
  RateLimit.register("limited", 10);

  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!RateLimit.check("limited", ip)) {
    req.respondText(429, "you shall not pass!");
  }
});
