const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function respond(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    const allowedOrigin = (
      env.ALLOWED_ORIGIN ||
      "https://orikaezedatahub.github.io"
    );

    const headers = {
      ...corsHeaders,
      "Access-Control-Allow-Origin":
        origin === allowedOrigin ? origin : allowedOrigin,
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers
      });
    }

    if (url.pathname === "/" || url.pathname
