// Headers / cache-control example.
//
// Overrides how the host caches the origin response. Runs in the
// origin-response phase (cache miss, after origin responds) so the
// Cache-Control we set here governs what the host stores for subsequent
// requests — regardless of what headers origin sent.

import { HttpResponse, onOriginResponse } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onOriginResponse((resp: HttpResponse): void => {
  resp.setCacheControl("max-age=10");
});
