import type { APIRoute } from "astro";
import { AUTH_COOKIE } from "@/middleware";

export const POST: APIRoute = ({ cookies, redirect }) => {
  cookies.delete(AUTH_COOKIE, { path: "/" });
  return redirect("/login");
};
