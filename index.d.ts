/** TypeScript-facing declarations for the AssemblyScript SDK public API. */

export class Headers {
  constructor(init?: string[][] | null);
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  delete(name: string): void;
  getSetCookie(): string[];
  entries(): string[][];
  keys(): string[];
  values(): string[];
  forEach(callback: (value: string, key: string, parent: Headers) => void): void;
}

export class Request {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array | null;
  text(): string | null;
  bytes(): Uint8Array | null;
  arrayBuffer(): ArrayBuffer | null;
  setBodyText(text: string | null): void;
  respondWith(response: Response): void;
  respondText(status: number, body?: string | null, headers?: Headers | null): void;
  bypassChallenge(): void;
  forceChallenge(): void;
}

export interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: Headers | null;
}

export class Response {
  constructor(body?: Uint8Array | null, init?: ResponseInit | null);
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array | null;
  errorKind: string | null;
  errorMessage: string | null;
  readonly request: Request;
  readonly ok: boolean;
  isError(): boolean;
  text(): string | null;
  bytes(): Uint8Array | null;
  arrayBuffer(): ArrayBuffer | null;
  setBodyText(text: string | null): void;
  setCacheControl(value: string): void;
}

export interface RequestInit {
  method?: string;
  headers?: Headers | null;
  body?: Uint8Array | null;
}

export type RequestHandler = (req: Request) => void;
export type ResponseHandler = (resp: Response) => void;

export function onClientRequest(handler: RequestHandler): void;
export function onOriginRequest(handler: RequestHandler): void;
export function onClientResponse(handler: ResponseHandler): void;
export function onOriginResponse(handler: ResponseHandler): void;
export function fetch(url: string, init?: RequestInit | null): Response;
export function getenv(name: string): string | null;

export namespace KV {
  function get(key: string): Uint8Array | null;
  function set(key: string, value: Uint8Array): void;
  function del(key: string): void;
  function counterGet(key: string): bigint;
  function counterSet(key: string, value: bigint): void;
  function incr(key: string, delta?: bigint): bigint;
  function getText(key: string): string | null;
  function setText(key: string, value: string): void;
}

export namespace RateLimit {
  function register(name: string, rps: number): void;
  function check(name: string, key: string): boolean;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array;
export function hmacSha256Str(key: string, message: string): Uint8Array;
export function sha256(message: Uint8Array): Uint8Array;
export function secureCompare(a: Uint8Array, b: Uint8Array): boolean;
export function jwtVerifyHs256(token: string, secret: string): string | null;
export function hexEncode(bytes: Uint8Array): string;

export class HtmlRules {
  insertBefore(selector: string, html: string): HtmlRules;
  insertAfter(selector: string, html: string): HtmlRules;
  prependInside(selector: string, html: string): HtmlRules;
  appendInside(selector: string, html: string): HtmlRules;
  replace(selector: string, html: string): HtmlRules;
  remove(selector: string): HtmlRules;
  setAttr(selector: string, name: string, value: string): HtmlRules;
  removeAttr(selector: string, name: string): HtmlRules;
  rewriteAttrRe(selector: string, name: string, pattern: string, template: string): HtmlRules;
  setText(selector: string, text: string): HtmlRules;
  install(): void;
}
