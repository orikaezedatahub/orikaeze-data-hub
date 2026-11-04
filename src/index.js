const MELE_BASE = "https://meledata.ng/api/v1/developer";
const PAYSTACK_BASE = "https://api.paystack.co";

const json = (data, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  });

const clean = value => String(value || "").trim();

function normalizeNetwork(value) {
  const key = String(value || "").trim().toUpperCase().replace(/[\\s_-]/g, "");
  if (key === "MTN") return "MTN";
  if (key === "GLO" || key === "GLOMOBILE") return "GLO";
  if (key === "AIRTEL") return "AIRTEL";
  if (["9MOBILE", "ETISALAT", "T2MOBILE"].includes(key)) return "9MOBILE";
  return key;
}

function extractPlans(result) {
  const candidates = [
    result?.plans,
    result?.data?.plans,
    Array.isArray(result?.data) ? result.data : null,
    result?.results,
    result?.data?.results,
    result?.data?.data
  ];
  const plans = candidates.find(Array.isArray);
  return plans || [];
}

const validPhone = value => /^0[789][01]\d{8}$/.test(value);

const money = value => Math.round(Number(value) * 100);

async function mele(env, path, options = {}) {
  return fetch(MELE_BASE + path, {
    method: options.method || "GET",
    headers: {
      "X-API-Key": env.MELE_SECRET_KEY,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function paystack(env, path) {
  return fetch(PAYSTACK_BASE + path, {
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`
    }
  });
}

async function getLiveStatus(env) {
  const response = await mele(env, "/wallet/");
  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error("MELE wallet could not be verified.");
  }

  if (result.data?.livemode !== true) {
    throw new Error("MELE live API access is not active.");
  }

  return result.data;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function validPaystackSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const expected = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(expected, signature.toLowerCase());
}

async function processPaidOrder(env, reference) {
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE reference = ?"
  ).bind(reference).first();

  if (!order) {
    return { success: false, message: "Order not found.", status: 404 };
  }

  if (order.delivery_status === "delivered") {
    return {
      success: true,
      message: "Service already delivered.",
      reference,
      delivery_status: "delivered"
    };
  }

  if (order.delivery_status === "pending_review") {
    return {
      success: false,
      message: "Payment was received but delivery needs review. Please do not pay again.",
      reference,
      delivery_status: "pending_review"
    };
  }

  const verification = await paystack(
    env,
    "/transaction/verify/" + encodeURIComponent(reference)
  );
  const payment = await verification.json();

  if (!verification.ok || !payment.status) {
    throw new Error("Paystack verification service is temporarily unavailable.");
  }

  // A signed charge.success webhook can arrive just before Paystack's
  // verification endpoint reflects the final status. Treat that as temporary
  // so Paystack retries the webhook rather than silently losing fulfillment.
  if (payment.data?.status !== "success") {
    throw new Error("Paystack has not confirmed the transaction yet.");
  }

  // These fields must match the stored order exactly before any provider debit.
  if (payment.data?.currency !== "NGN" ||
      Number(payment.data?.amount) !== Number(order.amount) ||
      payment.data?.reference !== reference) {
    return {
      success: false,
      message: "Payment details do not match this order.",
      reference,
      status: 400
    };
  }

  await getLiveStatus(env);

  // Claim a new paid order, or reclaim a processing order whose previous
  // execution stalled for over two minutes. This single conditional UPDATE is
  // the atomic lock: only one request can claim either state at a time.
  // Reusing the same MELE reference makes a recovery attempt idempotent.
  const lock = await env.DB.prepare(`
    UPDATE orders
    SET payment_status = 'success',
        delivery_status = 'processing',
        updated_at = CURRENT_TIMESTAMP
    WHERE reference = ?
      AND (
        (payment_status IN ('pending', 'success')
          AND delivery_status = 'pending')
        OR
        (payment_status = 'success'
          AND delivery_status = 'processing'
          AND updated_at < datetime('now', '-2 minutes'))
      )
  `).bind(reference).run();

  if (!lock.meta.changes) {
    const latest = await env.DB.prepare(
      "SELECT delivery_status FROM orders WHERE reference = ?"
    ).bind(reference).first();

    return {
      success: latest?.delivery_status === "delivered",
      message: latest?.delivery_status === "delivered"
        ? "Service already delivered."
        : "Payment is confirmed or being processed. Please do not pay again.",
      reference,
      delivery_status: latest?.delivery_status || "unknown"
    };
  }

  const providerReference = "ODH_" + reference;
  const purchaseResponse = order.service === "data"
    ? await mele(env, "/data/purchase", {
        method: "POST",
        body: {
          network: order.network,
          phone_number: order.phone,
          plan_id: Number(order.product_id),
          reference: providerReference
        }
      })
    : await mele(env, "/airtime/purchase", {
        method: "POST",
        body: {
          network: order.network,
          phone_number: order.phone,
          amount: Number(order.product_id),
          reference: providerReference
        }
      });

  // Transient provider failures must leave the order in "processing" so a
  // webhook retry can safely repeat the same idempotent MELE reference.
  if (purchaseResponse.status === 408 ||
      purchaseResponse.status === 429 ||
      purchaseResponse.status >= 500) {
    throw new Error("MELE purchase service is temporarily unavailable.");
  }

  let delivery;
  try {
    delivery = await purchaseResponse.json();
  } catch {
    delivery = {};
  }

  // MELE's documented success envelope includes data.status="success".
  // A top-level status:true alone only confirms the API request was accepted;
  // it must not be treated as proof that the customer's top-up was delivered.
  const delivered =
    purchaseResponse.ok &&
    (delivery.data?.status === "success" ||
     delivery.data?.status === "delivered");

  await env.DB.prepare(`
    UPDATE orders
    SET provider_reference = ?,
        delivery_status = ?,
        provider_response = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE reference = ?
  `).bind(
    providerReference,
    delivered ? "delivered" : "pending_review",
    JSON.stringify(delivery).slice(0, 5000),
    reference
  ).run();

  return {
    success: delivered,
    reference,
    delivery_status: delivered ? "delivered" : "pending_review",
    message: delivered
      ? "Payment successful. Your service has been delivered."
      : "Payment received. Your order is being checked. Please do not pay again."
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin =
      env.ALLOWED_ORIGIN || "https://orikaezedatahub.github.io";

    if (origin && origin !== allowedOrigin) {
      return json({ success: false, message: "Origin not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const reply = (data, status = 200) =>
      json(data, status, allowedOrigin);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return reply({
        success: true,
        service: "ORIKAEZE DATA HUB",
        message: "Backend is running."
      });
    }


    if (url.pathname === "/api/paystack-webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("x-paystack-signature") || "";
      const valid = await validPaystackSignature(
        rawBody,
        signature,
        env.PAYSTACK_SECRET_KEY
      );

      if (!valid) {
        return reply({ success: false, message: "Invalid webhook signature." }, 401);
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return reply({ success: false, message: "Invalid webhook payload." }, 400);
      }

      if (event.event !== "charge.success" || !event.data?.reference) {
        return reply({ success: true, message: "Event acknowledged." });
      }

      if (!env.DB || !env.PAYSTACK_SECRET_KEY || !env.MELE_SECRET_KEY) {
        return reply({ success: false, message: "Backend configuration is incomplete." }, 503);
      }

      try {
        const result = await processPaidOrder(env, clean(event.data.reference));
        // Missing orders can be a brief race/consistency issue. Ask Paystack
        // to retry rather than acknowledging and permanently dropping the event.
        if (result.status === 404 || (result.status && result.status >= 500)) {
          return reply({ success: false, message: "Payment event could not be processed yet." }, 500);
        }
        return reply({ success: true, message: "Payment event processed." });
      } catch (error) {
        console.error("Paystack webhook processing failed:", error);
        // A non-2xx response asks Paystack to retry the event. The MELE
        // reference is idempotent, so a retry cannot create a duplicate order.
        return reply({ success: false, message: "Payment event processing failed. Please retry." }, 500);
      }
    }

    if (!env.DB || !env.PAYSTACK_SECRET_KEY || !env.MELE_SECRET_KEY) {
      return reply({
        success: false,
        message: "Backend configuration is incomplete."
      }, 503);
    }

    if (url.pathname === "/api/plans" && request.method === "GET") {
      try {
        const response = await mele(env, "/data/plans");
        const result = await response.json();

        if (!response.ok) {
          return reply({
            success: false,
            message: "Could not retrieve data plans."
          }, 502);
        }

        return reply({
          success: true,
          plans: extractPlans(result).map(plan => ({ ...plan, network: normalizeNetwork(plan.network) }))
        });
      } catch {
        return reply({
          success: false,
          message: "Data plans are temporarily unavailable."
        }, 502);
      }
    }

    if (url.pathname === "/api/initialize-payment" &&
        request.method === "POST") {
      try {
        await getLiveStatus(env);
      } catch {
        return reply({
          success: false,
          message: "Live service delivery is not yet available."
        }, 503);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return reply({ success: false, message: "Invalid request." }, 400);
      }

      const email = clean(body.email).toLowerCase();
      const phone = clean(body.phone);
      const service = clean(body.service).toLowerCase();
      const network = clean(body.network).toUpperCase();
      const productId = clean(body.productId);
      const faceValue = Number(body.amount);

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !validPhone(phone) ||
          !["data", "airtime"].includes(service) ||
          !["MTN", "GLO", "AIRTEL", "9MOBILE"].includes(network)) {
        return reply({
          success: false,
          message: "Please check your email, phone and service details."
        }, 400);
      }

      let providerCost;
      let planId = null;

      if (service === "data") {
        const plansResponse = await mele(env, "/data/plans");
        const plansResult = await plansResponse.json();
        const plans = extractPlans(plansResult);

        const plan = plans.find(p =>
          String(p.plan_id) === productId &&
          normalizeNetwork(p.network) === network
        );

        if (!plansResponse.ok || !plan) {
          return reply({
            success: false,
            message: "Selected data plan is unavailable."
          }, 400);
        }

        providerCost = Number(plan.price);
        planId = plan.plan_id;
      } else {
        if (!Number.isFinite(faceValue) || faceValue < 100 ||
            faceValue > 100000) {
          return reply({
            success: false,
            message: "Airtime amount must be at least ₦100."
          }, 400);
        }

        providerCost = faceValue;
      }

      const markup = Math.max(0, Number(env.PROFIT_NAIRA || 0));
      const customerAmount = Math.ceil(providerCost + markup);

      if (!Number.isFinite(customerAmount) || customerAmount < 100) {
        return reply({
          success: false,
          message: "Invalid product price."
        }, 400);
      }

      const reference = "ODH_" + crypto.randomUUID().replace(/-/g, "");

      try {
        await env.DB.prepare(`
          INSERT INTO orders
          (reference, email, phone, service, network, product_id,
           amount, payment_status, delivery_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')
        `).bind(
          reference,
          email,
          phone,
          service,
          network,
          planId === null ? String(faceValue) : String(planId),
          money(customerAmount)
        ).run();

        const response = await fetch(
          PAYSTACK_BASE + "/transaction/initialize",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              email,
              amount: money(customerAmount),
              currency: "NGN",
              reference,
              callback_url: env.PAYSTACK_CALLBACK_URL || "https://orikaezedatahub.github.io/orikaeze-data-hub/payment.html",
              metadata: {
                service,
                network,
                phone,
                product_id: planId,
                order_reference: reference
              }
            })
          }
        );

        const result = await response.json();

        if (!response.ok || !result.status) {
          await env.DB.prepare(`
            UPDATE orders SET payment_status = 'initialization_failed',
            updated_at = CURRENT_TIMESTAMP WHERE reference = ?
          `).bind(reference).run();

          return reply({
            success: false,
            message: "Could not initialize payment."
          }, 502);
        }

        return reply({
          success: true,
          reference,
          authorization_url: result.data.authorization_url
        });
      } catch {
        return reply({
          success: false,
          message: "Payment initialization failed."
        }, 502);
      }
    }

    if (url.pathname === "/api/verify-payment" &&
        request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return reply({ success: false, message: "Invalid request." }, 400);
      }

      const reference = clean(body.reference);
      if (!reference || reference.length > 100) {
        return reply({ success: false, message: "Invalid payment reference." }, 400);
      }

      try {
        const result = await processPaidOrder(env, reference);
        const status = result.status || 200;
        return reply(result, status);
      } catch (error) {
        console.error("Payment verification failed:", error);
        return reply({
          success: false,
          message: "Transaction is being checked. Please do not pay again."
        }, 502);
      }
    }

    if (url.pathname === "/api/order-status" &&
        request.method === "GET") {
      const reference = clean(url.searchParams.get("reference"));

      if (!reference) {
        return reply({ success: false, message: "Reference required." }, 400);
      }

      const order = await env.DB.prepare(`
        SELECT reference, service, network, payment_status,
               delivery_status, created_at
        FROM orders WHERE reference = ?
      `).bind(reference).first();

      if (!order) {
        return reply({ success: false, message: "Order not found." }, 404);
      }

      return reply({ success: true, order });
    }

    return reply({
      success: false,
      message: "Route not found."
    }, 404);
  }
};
