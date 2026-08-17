import { defineMiddleware, sequence } from "astro:middleware";
import { getActionContext } from "astro:actions";
import { verify } from "@/lib/authCookie";
import { env } from "@/lib/env";
import { serviceFor, tenantService } from "@/lib/service";

export const AUTH_COOKIE = "lunch_auth";
const ACTION_RESULT_COOKIE = "lunch_action_result";

/** 401 JSON for API/action paths; null = caller should redirect to /login. */
function unauthorized(pathname: string) {
  if (pathname.startsWith("/api/") || pathname.startsWith("/_actions/")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

const auth = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // /login handles its own GET and POST; everything else requires auth.
  if (pathname === "/login") {
    return next();
  }

  const cookie = context.cookies.get(AUTH_COOKIE)?.value;
  const user = cookie ? verify(cookie, env.SESSION_SECRET) : null;

  if (!user) {
    return unauthorized(pathname) ?? context.redirect("/login");
  }

  const onTenantsPages =
    pathname === "/tenants" || pathname.startsWith("/tenants/");

  if (user.role === "superadmin") {
    // Management only: superadmin sees /tenants and can log out; the lunch
    // pages have no tenant to render for them.
    const allowed =
      onTenantsPages ||
      pathname === "/api/logout" ||
      pathname.startsWith("/_actions/");
    if (!allowed) return context.redirect("/tenants");
  } else {
    // A deleted tenant invalidates its users' cookies on their next request.
    const tenant = await tenantService.getTenant(user.tenantId!);
    if (!tenant) {
      context.cookies.delete(AUTH_COOKIE, { path: "/" });
      return unauthorized(pathname) ?? context.redirect("/login");
    }
    if (onTenantsPages) return context.redirect("/");
    context.locals.tenant = { id: tenant.id, name: tenant.name };
  }

  context.locals.user = user;
  context.locals.service = serviceFor(
    user.role === "superadmin" ? undefined : user.tenantId,
  );
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
