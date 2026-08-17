import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const snapshot = await locals.service.snapshot(locals.user.name);
  return new Response(JSON.stringify(snapshot), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
};
