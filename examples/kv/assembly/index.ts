// KV store example.
//
// All requests: increments a site-wide visit counter and forwards it to
// origin as x-visit-count (visible in access logs, useful for debugging).
//
// GET /note  — return the stored note (404 if not set)
// PUT /note  — store the request body as the note

import { Request, onClientRequest, KV } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  req.headers.set("x-visit-count", KV.incr("visits").toString());

  if (req.url != "/note") return;

  if (req.method == "PUT") {
    const body = req.text();
    KV.setText("note", body !== null ? body : "");
    req.respondText(200, "stored");
    return;
  }

  if (req.method == "GET") {
    const note = KV.getText("note");
    req.respondText(
      note !== null ? 200 : 404,
      note !== null ? note : "no note stored",
    );
    return;
  }
});
