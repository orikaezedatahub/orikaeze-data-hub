export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://orikaezedatahub.github.io";

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

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

    if (!env.PAYSTACK_SECRET_KEY) {
      return reply({ success: false, message: "Payment service is not configured." }, 503);
    }

    if (url.pathname === "/api/initialize-payment" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return reply({ success: false, message: "Invalid request." }, 400);
      }

      const email = String(body.email || "").trim();
      const productId = String(body.productId || "").trim();
      const phone = String(body.phone || "").trim();

      if (!email || !productId || !phone) {
        return reply({ success: false, message: "Email, product and phone are required." }, 400);
      }

      let products;

      try {
        products = JSON.parse(env.PRODUCTS_JSON || "{}");
      } catch {
        return reply({ success: false, message: "Product price list is invalid." }, 500);
      }

      const product = products[productId];

      if (!product || !Number.isInteger(product.amount) || product.amount < 100) {
        return reply({ success: false, message: "This product is not available yet." }, 400);
      }

      try {
        const response = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            amount: product.amount,
            currency: "NGN",
            metadata: {
              product_id: productId,
              phone,
              service: "ORIKAEZE DATA HUB"
            }
          })
        });

        const result = await response.json();

        if (!response.ok || !result.status) {
          return reply({ success: false, message: "Could not start payment." }, 502);
        }

        return reply({
          success: true,
          authorization_url: result.data.authorization_url,
          reference: result.data.reference
        });
      } catch {
        return reply({ success: false, message: "Payment service unavailable." }, 502);
      }
    }

    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return reply({ success: false, message: "Invalid request." }, 400);
      }

      const reference = String(body.reference || "").trim();

      if (!reference) {
        return reply({ success: false, message: "Payment reference is required." }, 400);
      }

      try {
        const response = await fetch(
          "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
          {
            headers: {
              Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`
            }
          }
        );

        const result = await response.json();

        if (!response.ok || !result.status || result.data?.status !== "success") {
          return reply({ success: false, message: "Payment verification failed." }, 400);
        }

        return reply({
          success: true,
          reference: result.data.reference,
          amount: result.data.amount,
          currency: result.data.currency,
          message: "Payment verified. Service delivery integration is pending."
        });
      } catch {
        return reply({ success: false, message: "Payment verification unavailable." }, 502);
      }
    }

    return reply({ success: false, message: "Route not found." }, 404);
  }
};
