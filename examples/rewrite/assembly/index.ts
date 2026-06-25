// Internal rewrite example.
//
// Rewrites the request before cache lookup so the worker serves a different
// origin host and path than the client asked for — without issuing a
// client-visible redirect. Here every request is repointed at a single
// origin host and collapsed to the site root.
//
// Runs in the client-request phase so the rewritten host/url is what gets
// cached and forwarded to origin.

import { Request, onClientRequest } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  req.headers.set("host", "origin.example.com");
  req.url = "/";
});
