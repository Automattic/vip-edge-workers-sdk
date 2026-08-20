// HTML rewrite example — href.li link anonymizer.
//
// On every origin HTML response, rewrite outbound links so clicks travel
// through href.li (which strips the Referer header before redirecting):
//
//   <a href="http://example.com/foo">  →  <a href="https://href.li/?http://example.com/foo">
//
// Belt-and-braces: also set rel="noreferrer noopener" on every <a href> so
// the Referer header isn't sent even on user-agents that ignore href.li
// (e.g. some script-blockers, very old browsers).
//
// The host applies these rules only to text/html and application/xhtml+xml
// responses; other content-types pass through untouched. The response body
// never enters the worker — lol-html runs server-side.

import { Response, onOriginResponse, HtmlRules } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onOriginResponse((_resp: Response): void => {
  new HtmlRules()
    // Capture the protocol so it's preserved in the wrapped URL. Only
    // touches absolute http(s) links — relative hrefs are left alone.
    .rewriteAttrRe("a[href]", "href", "^(https?://)", "https://href.li/?$1")
    .setAttr("a[href]", "rel", "noreferrer noopener")
    .install();
});
