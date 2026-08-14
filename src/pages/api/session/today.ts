import type { APIRoute } from "astro";
import { service } from "@/lib/service";

export const GET: APIRoute = async ({ locals }) => {
  const snapshot = await service.snapshot(locals.user.name);
  return new Response(JSON.stringify(snapshot), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
};
