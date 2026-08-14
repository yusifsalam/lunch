// @ts-check
import { defineConfig } from "astro/config";

import node from "@astrojs/node";

import tailwindcss from "@tailwindcss/vite";

import preact from "@astrojs/preact";

// https://astro.build/config
export default defineConfig({
  integrations: [preact()],
  adapter: node({ mode: "standalone" }),
  output: "server",

  trailingSlash: "never",

  vite: {
    plugins: [tailwindcss()],
  },
});
