// Udger Cloud Parser example.
//
// Calls Udger's v4 parse API with the inbound User-Agent and client IP,
// then uses the response to:
//   - Reject known crawlers with 403.
//   - Tag everything else with x-udger-device-class / x-udger-ua-class so
//     origin can serve device-appropriate variants.
//
// Requires UDGER_API_KEY in the environment. Without it, the handler is a no-op.
//
// Cloud Parser docs: https://udger.com/support/documentation/?doc=77

import { JSON } from "json-as";
import { Request, Headers, onClientRequest, fetch, getenv } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

// Subset of the Udger v4 response we care about. The real response is much
// larger and split into `user_agent` and `ip_address` objects — json-as
// ignores fields that are not declared on our classes.
@json
class UdgerUserAgent {
  ua_class: string = "";
  ua_family: string = "";
  device_class: string = "";
  os_family: string = "";
  crawler_category: string = "";
}

@json
class UdgerIpAddress {
  ip_classification: string = "";
}

@json
class UdgerInfo {
  user_agent: UdgerUserAgent = new UdgerUserAgent();
  ip_address: UdgerIpAddress = new UdgerIpAddress();
}

onClientRequest((req: Request): void => {
  const apiKey = getenv("UDGER_API_KEY");
  if (apiKey === null) return; // not configured — pass through

  const ua = req.headers.get("user-agent") || "";

  // x-forwarded-for may be a comma-separated chain; the leftmost entry is
  // the original client.
  let xff = req.headers.get("x-forwarded-for") || "";
  const comma = xff.indexOf(",");
  if (comma >= 0) xff = xff.slice(0, comma);
  const ip = xff.trim();

  if (ua == "" && ip == "") return;

  const url = "https://api.udger.com/v4/parse"
    + "?accesskey=" + encodeURIComponent(apiKey)
    + "&ip=" + encodeURIComponent(ip)
    + "&headers=" + encodeURIComponent("User-Agent: " + ua);

  const resp = fetch(url);
  // Soft-fail: don't block traffic on Udger outages.
  if (resp.isError() || !resp.ok) return;

  const body = resp.text();
  if (body === null) return;

  const info = JSON.parse<UdgerInfo>(body);
  const agent = info.user_agent;

  if (agent.ua_class == "Crawler") {
    req.respondText(403, "crawlers not allowed", new Headers([["content-type", "text/plain"]]));
    return;
  }

  // Tag the upstream request so origin / cache key can use the classification.
  if (agent.device_class != "") req.headers.set("x-udger-device-class", agent.device_class);
  if (agent.ua_class != "")     req.headers.set("x-udger-ua-class",     agent.ua_class);
});
