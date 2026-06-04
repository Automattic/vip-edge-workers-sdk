// HTML rewriting via the host's lol-html integration.
//
// Build up a declarative rule set with the chainable builder methods, then
// call install() once to submit the whole set to the host. The host applies
// the rules to the outgoing response body — the bytes never enter the worker.
//
// Only effective in response-phase handlers (onClientResponse / onOriginResponse),
// and only on responses whose Content-Type is text/html or application/xhtml+xml.
// Rules registered in request phases are dropped.

import { MsgpackWriter } from './msgpack';

// @ts-ignore — @external is an AS-only decorator
@external("html", "apply_rewrite_rules")
declare function _html_apply_rewrite_rules(ptr: i32, len: i32): i32;

class Rule {
  kind: u8 = 0;
  selector: string = "";
  args: string[] = [];
}

/**
 * Builder for a set of HTML rewrite rules. Chain `setAttr`, `replace`,
 * `prependInside`, etc., then call {@link install} to submit them to the host.
 *
 * Selectors use lol-html's CSS subset (`a[href]`, `div.cls`, `#id`,
 * `header > nav`, …). HTML arguments are inserted verbatim — escape any
 * user-controlled content yourself. `setText` is HTML-escaped automatically.
 *
 * Limits: ≤ 256 rules per call, ≤ 64 KiB total payload.
 */
export class HtmlRules {
  private rules: Rule[] = [];

  /** Insert `html` immediately before each matching element. */
  insertBefore(selector: string, html: string): HtmlRules { return this.add(0x01, selector, [html]); }
  /** Insert `html` immediately after each matching element. */
  insertAfter(selector: string, html: string):  HtmlRules { return this.add(0x02, selector, [html]); }
  /** Insert `html` as the first child of each matching element. */
  prependInside(selector: string, html: string): HtmlRules { return this.add(0x03, selector, [html]); }
  /** Insert `html` as the last child of each matching element. */
  appendInside(selector: string, html: string):  HtmlRules { return this.add(0x04, selector, [html]); }
  /** Replace each matching element (including its children) with `html`. */
  replace(selector: string, html: string):       HtmlRules { return this.add(0x05, selector, [html]); }
  /** Remove each matching element (and its children) from the document. */
  remove(selector: string):                      HtmlRules { return this.add(0x06, selector, []); }

  /** Set attribute `name` to `value` on each matching element. */
  setAttr(selector: string, name: string, value: string): HtmlRules {
    return this.add(0x10, selector, [name, value]);
  }
  /** Remove attribute `name` from each matching element. */
  removeAttr(selector: string, name: string): HtmlRules { return this.add(0x11, selector, [name]); }

  /**
   * Rewrite attribute `name` on each matching element by running
   * `pattern.replace_all(template)` against the current value.
   *
   * Uses the Rust `regex` crate (RE2-style, no lookarounds). Templates support
   * numbered captures (`$1`..`$9`), named captures (`${name}`), the whole
   * match (`$0`), and `$$` for a literal `$`. The attribute is left untouched
   * if it is absent or if the replacement produces the same string.
   *
   * Patterns are compiled host-side at {@link install} time, so an invalid
   * pattern fails the whole call with return code 4 — see {@link install}.
   */
  rewriteAttrRe(selector: string, name: string, pattern: string, template: string): HtmlRules {
    return this.add(0x12, selector, [name, pattern, template]);
  }

  /** Replace the text content of each matching element with `text` (HTML-escaped). */
  setText(selector: string, text: string): HtmlRules { return this.add(0x20, selector, [text]); }

  /**
   * Submit the accumulated rules to the host. Throws on any host validation
   * error (oversize payload, invalid selector, bad regex, bad wire format).
   */
  install(): void {
    const w = new MsgpackWriter();
    w.writeArray(this.rules.length);
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      w.writeArray(2 + r.args.length);
      w.writeUint16(<u16>r.kind);
      w.writeStr(r.selector);
      for (let j = 0; j < r.args.length; j++) {
        w.writeStr(r.args[j]);
      }
    }
    const buf = w.toArrayBuffer();
    const rc = _html_apply_rewrite_rules(changetype<i32>(buf), buf.byteLength);
    if (rc === 0) return;
    if (rc === 1) throw new Error("HtmlRules.install: payload too large (max 64 KiB)");
    if (rc === 2) throw new Error("HtmlRules.install: invalid CSS selector in rule set");
    if (rc === 3) throw new Error("HtmlRules.install: bad wire format (SDK bug)");
    if (rc === 4) throw new Error("HtmlRules.install: invalid regex pattern in rewriteAttrRe rule");
    throw new Error("HtmlRules.install: host returned " + rc.toString());
  }

  private add(kind: u8, selector: string, args: string[]): HtmlRules {
    const r = new Rule();
    r.kind = kind;
    r.selector = selector;
    r.args = args;
    this.rules.push(r);
    return this;
  }
}
