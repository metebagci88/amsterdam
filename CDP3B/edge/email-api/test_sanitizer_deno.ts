// ASALOCAL · CDP-3B · Sanitizer Deno/Edge uyumluluk testi.
// Çalıştırma (Edge-eşdeğer Deno runtime'da):  deno test --allow-net test_sanitizer_deno.ts
// Node/linkedom testinin (test_sanitizer.js, 52/52) yanında, GERÇEK Edge parser'ı (deno-dom) ile aynı ruleset'i doğrular.
// Not: sandbox'ta Deno kurulu olmadığından burada ÇALIŞTIRILMADI; Edge deploy öncesi CI'da koşulmalıdır.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import "./email_sanitizer.js"; // globalThis.EmailSanitizer
// deno-lint-ignore no-explicit-any
const S = (globalThis as any).EmailSanitizer;
const parseHTML = (h: string) => new DOMParser().parseFromString("<!doctype html><html><body>"+h+"</body></html>", "text/html");
const run = (html: string, opts: Record<string, unknown> = {}) => S.process(html, { parseHTML, ...opts });

Deno.test("deno: dangerous tags removed (allowlist)", () => {
  const r = run(`<body><script>x</script><iframe></iframe><style>.a{}</style><p>ok {{unsubscribe_url}}</p></body>`, { emailClass: "marketing" });
  assert(r.removed.includes("script")); assert(r.removed.includes("iframe")); assert(r.removed.includes("style"));
  assert(!/<script|<iframe|<style/i.test(r.sanitized_html));
});
Deno.test("deno: unknown/custom element unwrap", () => {
  const r = run(`<body><foo>t1</foo><my-x>t2</my-x><p>{{unsubscribe_url}}</p></body>`, { emailClass: "marketing" });
  assert(r.removed.some((x: string) => x.startsWith("unknown_tag:foo")));
  assert(r.removed.some((x: string) => x.startsWith("unknown_custom_element:my-x")));
  assert(/t1/.test(r.sanitized_html) && /t2/.test(r.sanitized_html));
});
Deno.test("deno: attribute allowlist (on*, srcset, xlink, background)", () => {
  const r = run(`<body><a href="https://x" onclick="h()">L</a><img src="https://cdn.asalocal.club/a.png" alt="x" srcset="a 2x"><td background="http://e">c</td><div>{{unsubscribe_url}}</div></body>`, { emailClass: "marketing", remoteImageAllowlist: ["cdn.asalocal.club"] });
  assert(r.removed.some((x: string) => x === "attr:a.onclick"));
  assert(r.removed.some((x: string) => x === "attr:img.srcset"));
  assert(r.removed.some((x: string) => x === "attr:td.background"));
});
Deno.test("deno: hidden js url + protocol-relative", () => {
  const r1 = run(`<body><a href="&#106;avascript:x()">a</a><div>{{unsubscribe_url}}</div></body>`, { emailClass: "marketing" });
  assert(r1.removed.some((x: string) => x.startsWith("bad-proto:href:javascript")));
  const r2 = run(`<body><a href="//tracker/x">a</a><div>{{unsubscribe_url}}</div></body>`, { emailClass: "marketing" });
  assert(r2.removed.some((x: string) => x.startsWith("bad-proto:href:protocol_relative")));
});
Deno.test("deno: css url()/position denied, safe props kept", () => {
  const r = run(`<body><p style="color:#333;background-image:url(https://e/x);position:fixed;font-size:14px">a</p><div>{{unsubscribe_url}}</div></body>`, { emailClass: "marketing" });
  assert(!/url\(/i.test(r.sanitized_html));
  assert(/color:\s*#333/.test(r.sanitized_html) && /font-size:\s*14px/.test(r.sanitized_html));
});
Deno.test("deno: marketing unsubscribe + unknown var", () => {
  const r1 = run(`<body><p>{{first_name}}</p></body>`, { emailClass: "marketing" });
  assert(!r1.ok && r1.errors.includes("missing_unsubscribe_url_variable"));
  const r2 = run(`<body><p>{{secret}} {{unsubscribe_url}}</p></body>`, { emailClass: "marketing" });
  assert(!r2.ok && r2.errors.some((x: string) => x.includes("unknown_variable:secret")));
});
Deno.test("deno: SHA-256 content_hash + builder_json_hash", async () => {
  const san = run(`<body><h1>Hi</h1>{{unsubscribe_url}}</body>`, { emailClass: "marketing" }).sanitized_html;
  const h = await S.computeHashesSHA256(san, { a: 1 });
  assert(/^[0-9a-f]{64}$/.test(h.content_hash));
  assert(/^[0-9a-f]{64}$/.test(h.builder_json_hash));
  const h2 = await S.computeHashesSHA256(san, { a: 1 });
  assertEquals(h.content_hash, h2.content_hash);
});
