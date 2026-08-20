// Redirect example.
//
// Two common redirect rules using plain string methods —
// AssemblyScript has no built-in RegExp, but startsWith / endsWith / slice
// cover the vast majority of real redirect needs.
//
// Rules applied in order; first match wins:
//   1. Path prefix rename:   /blog/* → /articles/*  (301 permanent)
//   2. Trailing-slash strip: /foo/   → /foo          (301 permanent, root / excluded)
//
// Runs in the client-request phase so the redirect fires before the cache
// lookup — the destination URL is what gets cached on a subsequent request.

import { Request, Headers, onClientRequest } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  // Rule 1: rename /blog and /blog/* → /articles and /articles/*
  if (req.url == "/blog" || req.url.startsWith("/blog/")) {
    redirect(req, "/articles" + req.url.slice(5));
    return;
  }

  // Rule 2: strip a trailing slash (/foo/ → /foo), leaving the root "/" alone.
  // Split off any query string first so "/foo/?a=1" → "/foo?a=1".
  const qPos = req.url.indexOf("?");
  const path = qPos >= 0 ? req.url.slice(0, qPos) : req.url;
  const query = qPos >= 0 ? req.url.slice(qPos) : "";
  if (path.length > 1 && path.endsWith("/")) {
    redirect(req, path.slice(0, path.length - 1) + query);
    return;
  }
});

function redirect(req: Request, location: string): void {
  req.respondText(301, null, new Headers([["location", location]]));
}
