import { defineMiddleware } from "astro:middleware";
import { verify } from "@/lib/authCookie";
import { env } from "@/lib/env";

export const AUTH_COOKIE = "lunch_auth";

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;

  // /login handles its own GET and POST; everything else requires auth.
  if (pathname === "/login") {
    return next();
  }

  const cookie = context.cookies.get(AUTH_COOKIE)?.value;
  const user = cookie ? verify(cookie, env.SESSION_SECRET) : null;

  if (!user) {
    if (pathname.startsWith("/api/") || pathname.startsWith("/_actions/")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return context.redirect("/login");
  }

  context.locals.user = user;
  return next();
});
