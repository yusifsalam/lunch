// @ts-check
import { defineConfig } from "astro/config";

import node from "@astrojs/node";

import tailwindcss from "@tailwindcss/vite";

import preact from "@astrojs/preact";

// Public hostname the app is served on in production (e.g. lunch.yusif.fi).
// Read at BUILD time — in Docker it arrives as a build arg, not runtime env.
const siteHostname = process.env.SITE_HOSTNAME;

// https://astro.build/config
export default defineConfig({
  integrations: [preact()],
  adapter: node({ mode: "standalone" }),
  output: "server",

  trailingSlash: "never",

  // Trust Caddy's X-Forwarded-Proto/Host for the production domain, so the
  // request URL reconstructs as https and the CSRF origin check passes behind
  // TLS termination. Unlisted hosts (e.g. localhost in dev) are unaffected.
  security: siteHostname
    ? { allowedDomains: [{ hostname: siteHostname, protocol: "https" }] }
    : undefined,

  vite: {
    plugins: [tailwindcss()],
  },
});
