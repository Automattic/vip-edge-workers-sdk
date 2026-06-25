// Webhook example.
//
// Verifies GitHub-style HMAC-SHA256 webhook signatures (x-hub-signature-256).
// Requests with a missing or invalid signature are rejected with 401; valid
// requests pass through to origin unchanged.
//
// The HMAC secret is read from the WEBHOOK_SECRET environment variable, which
// is injected at deploy time and never appears in the WASM binary or on the wire.

import {
  Request, getenv, onClientRequest,
  hmacSha256Str, secureCompare, hexEncode,
} from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
  client_request_body,    // buffer the request body so it's available for HMAC computation
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  const secret = getenv("WEBHOOK_SECRET");
  if (secret === null) {
    req.respondText(500, "webhook secret not configured");
    return;
  }

  const sig = req.headers.get("x-hub-signature-256");
  if (sig === null) {
    req.respondText(401, "missing x-hub-signature-256 header");
    return;
  }

  const body = req.text() || "";
  const expected = "sha256=" + hexEncode(hmacSha256Str(secret, body));

  const sigBytes      = Uint8Array.wrap(String.UTF8.encode(sig));
  const expectedBytes = Uint8Array.wrap(String.UTF8.encode(expected));
  if (!secureCompare(sigBytes, expectedBytes)) {
    req.respondText(401, "invalid signature");
    return;
  }
});
