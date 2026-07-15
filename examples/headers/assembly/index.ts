// Headers / cache-control example.
//
// Runs in the origin-response phase (cache miss, after origin responds), so
// the Cache-Control we set here governs what the host stores for subsequent
// requests — regardless of what headers origin sent. PDF responses also get
// tagged with an extra header, matched on the original request URL via the
// read-only `resp.request` view.

import { Response, onOriginResponse } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onOriginResponse((resp: Response): void => {
  resp.setCacheControl("max-age=10");

  const path = resp.request.url.split("?")[0];
  if (path.endsWith(".pdf")) {
    resp.headers.set("x-pdf", "1");
  }
});
