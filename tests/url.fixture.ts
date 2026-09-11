import { Request, Response } from "../assembly/api";
import { URLSearchParams, Cookies, formDecode, formEncode } from "../assembly/url";

export function parseGet(): string | null {
  return new URLSearchParams("?a=1&b=%20x+y&a=2&empty&=v&").get("b");
}

export function parseGetAll(): string {
  return new URLSearchParams("a=1&b=2&a=3").getAll("a").join(",");
}

export function parseEmptyValue(): bool {
  const p = new URLSearchParams("flag&x=");
  return p.has("flag") && p.get("flag") == "" && p.get("x") == "" && p.size == 2;
}

export function parseEmptyName(): bool {
  const p = new URLSearchParams("=v");
  return p.size == 1 && p.get("") == "v";
}

export function missingIsNull(): bool {
  return new URLSearchParams("a=1").get("zzz") === null;
}

export function decodeUnicode(): string {
  return new URLSearchParams("q=caf%C3%A9+%26+%C3%BC").get("q")!;
}

export function encodeUnicode(): string {
  const p = new URLSearchParams();
  p.set("q", "café & ü");
  p.append("safe", "A-z_0.9*");
  return p.toString();
}

export function malformedEscapes(): string {
  return formDecode("%zz%4%") + "|" + formDecode("100%") + "|" + formEncode("~/?#=&");
}

export function setReplacesInPlace(): string {
  const p = new URLSearchParams("a=1&b=2&a=3&c=4");
  p.set("a", "9");
  return p.toString();
}

export function deleteAll(): string {
  const p = new URLSearchParams("a=1&b=2&a=3");
  p.delete("a");
  p.delete("nope");
  return p.toString();
}

export function sortIsStable(): string {
  const p = new URLSearchParams("z=1&b=first&a=0&b=second");
  p.sort();
  return p.toString();
}

export function keysValuesEntries(): string {
  const p = new URLSearchParams("a=1&b=2");
  const entries = p.entries();
  return p.keys().join(",") + "|" + p.values().join(",") + "|" + entries[1][0] + "=" + entries[1][1];
}

export function requestPathAndSearch(): string {
  const req = new Request();
  req.url = "/p/a?x=1&y=2";
  return req.path + "|" + req.query + "|" + req.queryParams.get("y")!;
}

export function requestWithoutQuery(): bool {
  const req = new Request();
  req.url = "/only";
  return req.path == "/only" && req.query == "" && req.queryParams.size == 0;
}

export function requestTrailingQuestionMark(): bool {
  const req = new Request();
  req.url = "/x?";
  return req.path == "/x" && req.query == "" && req.queryParams.size == 0;
}

export function queryParamsWriteBack(): string {
  const req = new Request();
  req.url = "/p?b=2&a=1&utm_source=x";
  const params = req.queryParams;
  params.delete("utm_source");
  const first = req.url;
  params.sort();
  const second = req.url;
  params.delete("a");
  params.delete("b");
  return first + "|" + second + "|" + req.url;
}

export function queryParamsCached(): bool {
  const req = new Request();
  req.url = "/p?a=1";
  const first = req.queryParams;
  first.set("a", "2");
  return req.queryParams === first && req.url == "/p?a=2";
}

export function urlAssignmentResetsCache(): string {
  const req = new Request();
  req.url = "/p?a=1";
  req.queryParams.get("a");
  req.url = "/q?a=other";
  return req.queryParams.get("a")!;
}

export function pathSetterKeepsQuery(): string {
  const req = new Request();
  req.url = "/old?k=v";
  req.path = "/new";
  return req.url;
}

export function querySetterVariants(): string {
  const req = new Request();
  req.url = "/p?k=v";
  req.query = "a=1";
  const bare = req.url;
  req.query = "?b=2";
  const prefixed = req.url;
  req.query = "?";
  const lone = req.url;
  req.query = "";
  return bare + "|" + prefixed + "|" + lone + "|" + req.url;
}

export function cookiesParse(): bool {
  const c = new Cookies("a=1; b= two ; a=3; junk; =nope; q=\"x=y\"");
  return c.get("a") == "1"
    && c.get("b") == "two"
    && c.get("q") == "\"x=y\""
    && !c.has("junk")
    && c.get("missing") === null
    && c.size == 3
    && c.keys().join(",") == "a,b,q";
}

export function requestCookiesCached(): bool {
  const req = new Request();
  req.headers.set("cookie", "session=abc");
  const first = req.cookies;
  const same = req.cookies;
  req.headers.set("cookie", "session=def");
  const refreshed = req.cookies;
  return first === same
    && first.get("session") == "abc"
    && refreshed !== first
    && refreshed.get("session") == "def";
}

export function requestCookiesEmpty(): bool {
  const req = new Request();
  return req.cookies.size == 0 && req.cookies.get("a") === null;
}

export function responseRedirectDefault(): bool {
  const resp = Response.redirect("/there");
  return resp.status == 302 && resp.headers.get("location") == "/there" && resp.body === null;
}

export function responseRedirectPermanent(): bool {
  return Response.redirect("/there", 308).status == 308;
}

export function responseRedirectInvalidStatus(): void {
  Response.redirect("/there", 200);
}

export function respondRedirect(): void {
  const req = new Request();
  req.url = "/from";
  req.respondRedirect("/to", 301);
}

export function readonlyViewReads(): bool {
  const view = Request._bindResponseView();
  return view.path == "" && view.query == "" && view.queryParams.size == 0 && view.cookies.size == 0;
}

export function readonlyViewSearchParamsThrows(): void {
  Request._bindResponseView().queryParams.set("a", "1");
}

export function readonlyViewPathnameThrows(): void {
  Request._bindResponseView().path = "/x";
}
