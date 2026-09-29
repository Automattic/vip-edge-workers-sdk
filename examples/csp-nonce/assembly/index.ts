// CSP nonce example — per-response Content-Security-Policy with script nonces.
//
// On every HTML response, generate a fresh random nonce, send it in the
// Content-Security-Policy header, and stamp the same value onto the page's
// trusted <script> tags so only those scripts are allowed to run.
//
// Runs in the client-response phase so each visitor gets a new nonce even
// when the page comes from cache. POLICY is a minimal starting point: see
// README.md for what to consider before using this on a real site.

import {
  Response, onClientResponse, HtmlRules, getRandomValues, hexEncode,
} from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

// `{nonce}` is replaced with the per-response value.
const POLICY = "script-src 'self' 'nonce-{nonce}'; object-src 'none'; base-uri 'self'";

onClientResponse((resp: Response): void => {
  // 16 bytes (128 bits) from the host's secure random source. Never use
  // Math.random() for this: its output can be predicted.
  const nonce = hexEncode(getRandomValues(new Uint8Array(16)));

  resp.headers.set("content-security-policy", POLICY.replace("{nonce}", nonce));

  new HtmlRules()
    .setAttr("script[data-csp-nonce]", "nonce", nonce)
    .setAttr('script[type="importmap"]', "nonce", nonce)
    .setAttr('script[type="speculationrules"]', "nonce", nonce)
    .setAttr('script[type="module"]', "nonce", nonce)
    .install();
});
