// Host half of dsh-mobile-harden: pins the served viewport so touch layouts
// cannot tap-zoom, focus-zoom, or double-tap-zoom. All DOM behavior lives in
// the Client half (lib/client.js); this is markup only.

const name = "dsh-mobile-harden";

// Hard dependency: without it the row can apply before webServer exists,
// ctx.get returns undefined, and the viewport tap silently never registers.
const inject = ["webServer"];

const VIEWPORT =
  "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

function transformIndex(html) {
  let out = html;
  const tag = `<meta name="viewport" content="${VIEWPORT}" />`;
  const metaRe = /<meta\s+name="viewport"[^>]*>/i;
  if (metaRe.test(out)) {
    out = out.replace(metaRe, () => tag);
  } else {
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => m + tag);
  }
  return out;
}

function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (!webServer || typeof webServer.tapIndex !== "function") return;
  ctx.effect(() => webServer.tapIndex(transformIndex), "dsh-mobile-harden: viewport");
}

export { apply, inject, name, transformIndex, VIEWPORT };
