import { defineMiddleware, sequence } from "astro:middleware";
import { getActionContext } from "astro:actions";
import { verify } from "@/lib/authCookie";
import { env } from "@/lib/env";

export const AUTH_COOKIE = "lunch_auth";
const ACTION_RESULT_COOKIE = "lunch_action_result";

const auth = defineMiddleware((context, next) => {
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

// Form-posted actions leave ?_action=… in the address bar and make refresh
// resubmit; run them here instead, then redirect back to the clean page URL
// (POST/Redirect/GET). The result rides a one-shot cookie so pages can still
// read it via Astro.getActionResult() after the redirect.
const formActionRedirect = defineMiddleware(async (context, next) => {
  const { action, setActionResult, serializeActionResult } =
    getActionContext(context);

  const forwarded = context.cookies.get(ACTION_RESULT_COOKIE);
  if (forwarded) {
    context.cookies.delete(ACTION_RESULT_COOKIE, { path: "/" });
    try {
      const { actionName, actionResult } = forwarded.json();
      setActionResult(actionName, actionResult);
    } catch {
      // Malformed cookie; render the page without an action result.
    }
    return next();
  }

  if (action?.calledFrom === "form") {
    const result = await action.handler();
    context.cookies.set(
      ACTION_RESULT_COOKIE,
      { actionName: action.name, actionResult: serializeActionResult(result) },
      { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 },
    );
    return context.redirect(context.originPathname, 303);
  }

  return next();
});

export const onRequest = sequence(auth, formActionRedirect);
