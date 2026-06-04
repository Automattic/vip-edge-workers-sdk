// Outbound fetch example.
//
// GET /ip  — fetches the caller's public IP from ifconfig.me and returns it.
// Anything else passes through to origin.

import { HttpRequest, onClientRequest, fetch } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: HttpRequest): void => {
  if (!req.uri.startsWith("/ip")) return;

  const resp = fetch("https://ifconfig.me/ip", "GET", [["accept", "text/plain"]]);

  if (resp.isError()) {
    req.respondText(502, "upstream error: " + resp.errorKind!);
    return;
  }

  req.respondText(resp.status, resp.text(), [["content-type", "text/plain"]]);
});
