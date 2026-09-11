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

import { Request, onClientRequest } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  const path = req.path;

  // Rule 1: rename /blog and /blog/* → /articles and /articles/*
  if (path == "/blog" || path.startsWith("/blog/")) {
    req.path = "/articles" + path.slice(5);
    req.respondRedirect(req.url, 301);
    return;
  }

  // Rule 2: strip a trailing slash (/foo/ → /foo), leaving the root "/" alone.
  // Assigning req.path keeps the query string, so "/foo/?a=1" → "/foo?a=1".
  if (path.length > 1 && path.endsWith("/")) {
    req.path = path.slice(0, path.length - 1);
    req.respondRedirect(req.url, 301);
    return;
  }
});
