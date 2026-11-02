export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN ||
      "https://orikaezedatahub.github.io";

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin === allowedOrigin
        ? origin
        : allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return reply({
        success: true,
        service: "ORIKAEZE DATA HUB",
        message: "Backend is running."
      });
    }

    if (
      url.pathname === "/api/verify-payment" &&
      request.method === "POST"
    ) {
      if (!env.PAYSTACK_SECRET_KEY) {
        return reply({
          success: false,
          message: "Paystack is not configured yet."
        }, 503);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return reply({
          success: false,
          message: "Invalid request."
        }, 400);
      }

      const reference = String(body.reference || "").trim();

      if (!reference) {
        return reply({
          success: false,
          message: "Payment reference is required."
        }, 400);
      }

      try {
        const response = await fetch(
          "https://api.paystack.co/transaction/verify/" +
          encodeURIComponent(reference),
          {
            headers: {
              Authorization:
                "Bearer " + env.PAYSTACK_SECRET_KEY
            }
          }
        );

        const result = await response.json();

        if (
          !response.ok ||
          !result.status ||
          result.data?.status !== "success"
        ) {
          return reply({
            success: false,
            message: "Payment verification failed."
          }, 400);
        }

        return reply({
          success: true,
          reference: result.data.reference,
          amount: result.data.amount,
          currency: result.data.currency,
          message: "Payment verified. Delivery is not yet enabled."
        });

      } catch {
        return reply({
          success: false,
          message: "Payment service unavailable."
        }, 502);
      }
    }

    if (
      url.pathname === "/api/purchase" &&
      request.method === "POST"
    ) {
      return reply({
        success: false,
        message: "Automatic delivery is not configured yet."
      }, 503);
    }

    return reply({
      success: false,
      message: "Route not found."
    }, 404);
  }
};
