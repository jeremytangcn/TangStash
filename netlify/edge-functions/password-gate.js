// netlify/edge-functions/password-gate.js
//
// Site-wide password gate, since dashboard-toggle password protection is a
// Netlify Pro feature. This is the free-tier workaround: an Edge Function
// that checks for a signed cookie before letting any request through, and
// shows a plain login form if it's missing.
//
// Set the SITE_PASSWORD environment variable in the Netlify dashboard
// (Site settings > Environment variables) before deploying — this function
// will refuse to gate anything if it's not set, so the site fails CLOSED
// rather than accidentally open.
//
// NOTE: this is a basic shared-password gate, not real per-user auth —
// appropriate for "keep this off Google and casual visitors" for a
// single-user personal app, not for anything security-sensitive.

const COOKIE_NAME = "ts_auth";

export default async (request, context) => {
  const password = Deno.env.get("SITE_PASSWORD");
  if (!password) {
    return new Response(
      "Site password not configured — set SITE_PASSWORD in Netlify environment variables.",
      { status: 500 }
    );
  }

  const url = new URL(request.url);

  // Handle the login form submission
  if (url.pathname === "/__auth" && request.method === "POST") {
    const form = await request.formData();
    const submitted = form.get("password");

    if (submitted === password) {
      const redirectTo = form.get("redirect") || "/";
      const headers = new Headers({ Location: redirectTo });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
      );
      return new Response(null, { status: 302, headers });
    }

    return new Response(renderLoginPage(url.pathname, "Incorrect password."), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Check existing cookie
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (cookies[COOKIE_NAME] === password) {
    return context.next(); // authenticated — let the request through
  }

  // Not authenticated — show the login form instead of the real page
  return new Response(renderLoginPage(url.pathname), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

function parseCookies(cookieHeader) {
  const out = {};
  cookieHeader.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) out[key] = decodeURIComponent(rest.join("="));
  });
  return out;
}

function renderLoginPage(redirectTo, errorMessage) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TangStash — Sign in</title>
  <style>
    body{ background:#0A0E17; color:#ECEEF3; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    form{ background:#10151F; border:1px solid #262E40; border-radius:16px; padding:28px; width:280px; }
    h1{ font-size:18px; margin:0 0 16px; }
    input{ width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid #262E40; background:#171D2B; color:#ECEEF3; margin-bottom:12px; }
    button{ width:100%; padding:11px; border:none; border-radius:10px; background:#D4A44C; color:#1a1300; font-weight:700; cursor:pointer; }
    .err{ color:#E8694F; font-size:13px; margin-bottom:10px; }
  </style>
</head>
<body>
  <form method="POST" action="/__auth">
    <h1>TangStash</h1>
    ${errorMessage ? `<div class="err">${errorMessage}</div>` : ""}
    <input type="hidden" name="redirect" value="${redirectTo}">
    <input type="password" name="password" placeholder="Site password" autofocus>
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}
