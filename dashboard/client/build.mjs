// Client bundle for the Cloudflare deployment — plain Bun.build, no
// Muse SDK. Produces ../public/dashboard/ (the directory the
// Worker's [assets] binding serves under /dashboard/*):
//   bun run build:client
//
// Tailwind v4 is compiled by bun-plugin-tailwind; the moon artwork
// and any other imported assets are emitted as hashed files next to
// the bundle.

import tailwindPlugin from "bun-plugin-tailwind";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outdir = fileURLToPath(new URL("../public/dashboard/", import.meta.url));
rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./index.html", import.meta.url))],
  outdir,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`client bundle -> ${outdir}`);
