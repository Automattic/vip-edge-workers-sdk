// Internal rewrite example.
//
// Rewrites the request before cache lookup so the worker serves a different
// origin host and path than the client asked for — without issuing a
// client-visible redirect. Here every request is repointed at a single
// origin host and collapsed to the site root.
//
// Runs in the client-request phase so the rewritten host/uri is what gets
// cached and forwarded to origin.

import { HttpRequest, onClientRequest } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: HttpRequest): void => {
  req.setHeader("host", "origin.example.com");
  req.uri = "/";
});
