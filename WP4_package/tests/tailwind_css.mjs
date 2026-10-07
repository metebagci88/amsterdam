// WP4 · builds the CSS the homepage gets from cdn.tailwindcss.com (Play CDN v3, ?plugins=forms,container-queries)
// with the page's OWN inline tailwind.config, so the Playwright layout checks (390px overflow, fixed overlays,
// outside click) run against real utility classes instead of an unstyled page. Test-only; never deployed.
//   Needs tailwindcss@3.4.17 + @tailwindcss/forms + @tailwindcss/container-queries on NODE_PATH.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function tailwindAvailable() {
  try { require.resolve("tailwindcss"); require.resolve("@tailwindcss/forms"); require.resolve("@tailwindcss/container-queries"); require.resolve("postcss"); return true; }
  catch { return false; }
}

export async function buildTailwindCss(html) {
  const tailwindcss = require("tailwindcss");
  const postcss = require("postcss");
  const forms = require("@tailwindcss/forms");
  const containerQueries = require("@tailwindcss/container-queries");
  const m = html.match(/<script id="tailwind-config">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("tailwind-config script not found");
  const tailwind = {};
  new Function("tailwind", m[1])(tailwind); // the page assigns tailwind.config = {...}
  const config = Object.assign({}, tailwind.config, {
    content: [{ raw: html, extension: "html" }], // classes in markup AND in inline JS strings
    plugins: [forms, containerQueries]
  });
  const out = await postcss([tailwindcss(config)]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;", { from: undefined });
  return out.css;
}

// Served in place of the Play CDN script: defines window.tailwind (the page assigns .config) and injects the CSS.
export function cdnShim(css) {
  return "window.tailwind={config:{}};(function(){var s=document.createElement('style');s.setAttribute('data-wp4','tailwind-build');s.textContent="
    + JSON.stringify(css) + ";(document.head||document.documentElement).appendChild(s);})();";
}
