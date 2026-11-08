const MELE_BASE = "https://meledata.ng/api/v1/developer";
const PAYSTACK_BASE = "https://api.paystack.co";
const BUILD_VERSION = "2026-11-07.1-security";

const json = (data, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cache-Control": "no-store",
      "Strict-Transport-Security": "max-age=31536000",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-site",
      "X-Permitted-Cross-Domain-Policies": "none"
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

// ORIKAEZE HUB tiered selling margin (NGN), applied server-side.
// Provider cost below ₦500: ₦10; ₦500–₦1,499: ₦20; ₦1,500 and above: ₦30.
function getMarkup(providerCost) {
  const cost = Number(providerCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  if (cost < 500) return 10;
  if (cost < 1500) return 20;
  return 30;
}

function getSellingPrice(providerCost) {
  return Math.ceil(Number(providerCost) + getMarkup(providerCost));
}

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

  // pending_review orders may be safely reconciled by retrying the exact same
  // MELE reference. MELE documents reference-based idempotency: a repeated
  // reference returns the original transaction without a second debit.
  
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
          AND delivery_status IN ('pending', 'pending_review'))
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


async function hashText(v){const x=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(x)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function checkRateLimit(env,request,scope,maxAttempts,windowMinutes,identifier=""){
  const ip=request.headers.get("CF-Connecting-IP")||"unknown";
  // Hash the IP and optional account identifier together; never store either in plaintext.
  const ipHash=await hashText(ip+"|"+String(identifier).toLowerCase());
  await env.DB.prepare(`
    INSERT INTO security_rate_limits(scope,ip_hash,window_started_at,attempts,blocked_until)
    VALUES(?,?,CURRENT_TIMESTAMP,1,NULL)
    ON CONFLICT(scope,ip_hash) DO UPDATE SET
      attempts=CASE WHEN window_started_at<=datetime('now','-${windowMinutes} minutes') THEN 1 ELSE attempts+1 END,
      window_started_at=CASE WHEN window_started_at<=datetime('now','-${windowMinutes} minutes') THEN CURRENT_TIMESTAMP ELSE window_started_at END,
      blocked_until=CASE
        WHEN blocked_until IS NOT NULL AND blocked_until>CURRENT_TIMESTAMP THEN blocked_until
        WHEN window_started_at<=datetime('now','-${windowMinutes} minutes') THEN NULL
        WHEN attempts+1>=${maxAttempts} THEN datetime('now','+${windowMinutes} minutes')
        ELSE NULL END
  `).bind(scope,ipHash).run();
  const state=await env.DB.prepare("SELECT blocked_until FROM security_rate_limits WHERE scope=? AND ip_hash=?").bind(scope,ipHash).first();
  return !state?.blocked_until || state.blocked_until<=new Date().toISOString().replace("T"," ").slice(0,19);
}
function issueToken(){return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function securePassword(v,s){const salt=s?Uint8Array.from(s.match(/.{2}/g),x=>parseInt(x,16)):crypto.getRandomValues(new Uint8Array(16));const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(v),"PBKDF2",false,["deriveBits"]);const b=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:100000,hash:"SHA-256"},k,256);return{salt:[...salt].map(x=>x.toString(16).padStart(2,"0")).join(""),hash:[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}}
async function adminSession(req,env){const a=req.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7).trim():"";if(t.length!==64)return false;const row=await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP").bind(await hashText(t)).first();return !!row}
async function sessionUser(req,env){const a=req.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7).trim():"";if(t.length!==64)return null;return env.DB.prepare("SELECT c.id,c.full_name,c.email,c.phone FROM auth_sessions s JOIN customers c ON c.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP").bind(await hashText(t)).first()}
async function settleWalletTopup(env,ref){const t=await env.DB.prepare("SELECT * FROM wallet_topups WHERE reference=?").bind(ref).first();if(!t)return{success:false,status:404,message:"Deposit not found."};if(t.status==="credited")return{success:true,message:"Wallet already credited."};if(t.status!=="pending")return{success:false,status:409,message:"This wallet funding is not awaiting settlement."};const r=await paystack(env,"/transaction/verify/"+encodeURIComponent(ref)),v=await r.json();if(!r.ok||!v.status)throw Error("Paystack verification unavailable");if(v.data?.status!=="success")throw Error("Payment not confirmed");if(v.data?.currency!=="NGN"||Number(v.data?.amount)!==t.amount_kobo||v.data?.reference!==ref)return{success:false,status:400,message:"Payment details do not match."};await env.DB.batch([env.DB.prepare("UPDATE wallet_topups SET status='settling',updated_at=CURRENT_TIMESTAMP WHERE reference=? AND status='pending'").bind(ref),env.DB.prepare("UPDATE wallets SET balance_kobo=balance_kobo+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND EXISTS(SELECT 1 FROM wallet_topups WHERE reference=? AND status='settling') AND NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(t.amount_kobo,t.user_id,ref,ref),env.DB.prepare("INSERT INTO wallet_ledger(user_id,reference,type,amount_kobo,description,status) SELECT ?,?,'credit',?,'Wallet funding via Paystack','success' WHERE EXISTS(SELECT 1 FROM wallet_topups WHERE reference=? AND status='settling') AND NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(t.user_id,ref,t.amount_kobo,ref,ref),env.DB.prepare("UPDATE wallet_topups SET status='credited',updated_at=CURRENT_TIMESTAMP WHERE reference=? AND status='settling'").bind(ref)]);const settled=await env.DB.prepare("SELECT status FROM wallet_topups WHERE reference=?").bind(ref).first();if(settled?.status!=="credited")throw Error("Wallet funding settlement did not complete.");return{success:true,message:"Wallet funded successfully."}}
async function refundWalletPurchase(env,p,detail){const ref="REF_"+p.reference;await env.DB.batch([env.DB.prepare("UPDATE wallets SET balance_kobo=balance_kobo+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(p.amount_kobo,p.user_id,ref),env.DB.prepare("INSERT INTO wallet_ledger(user_id,reference,type,amount_kobo,description,status) SELECT ?,?,'credit',?,'Refund for failed purchase','success' WHERE NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(p.user_id,ref,p.amount_kobo,ref),env.DB.prepare("UPDATE wallet_orders SET status='refunded',provider_response=?,updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(String(detail).slice(0,3000),p.reference),env.DB.prepare("UPDATE wallet_ledger SET status='refunded' WHERE reference=?").bind(p.reference)])}

export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin =
      env.ALLOWED_ORIGIN || "https://orikaezedatahub.github.io";
    const previewApiHost =
      url.hostname.endsWith("-orikaeze-data-hub.eruakennethnnabuike.workers.dev") &&
      url.hostname !== "orikaeze-data-hub.eruakennethnnabuike.workers.dev";
    const previewSiteRequest =
      previewApiHost &&
      /^https:\/\/([a-z0-9-]+-)?orikaeze-data-hub-site\.eruakennethnnabuike\.workers\.dev$/i.test(origin);
    const previewSameOriginRequest =
      previewApiHost && origin === url.origin;
    const previewRequest = previewSiteRequest || previewSameOriginRequest;
    const responseOrigin = previewRequest ? origin : allowedOrigin;

    if (origin && origin !== allowedOrigin && !previewRequest) {
      return json({ success: false, message: "Origin not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": responseOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin"
        }
      });
    }

    const reply = (data, status = 200) =>
      json(data, status, responseOrigin);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return reply({
        success: true,
        service: "ORIKAEZE DATA HUB",
        message: "Backend is running.",
        build: BUILD_VERSION
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

      if (!env.DB || !env.PAYSTACK_SECRET_KEY) {
        return reply({ success: false, message: "Backend configuration is incomplete." }, 503);
      }

      try {
        const eventRef=clean(event.data.reference);
        const deposit=await env.DB.prepare("SELECT reference FROM wallet_topups WHERE reference=?").bind(eventRef).first();
        if(deposit){const done=await settleWalletTopup(env,eventRef);if(done.status===404||done.status>=500)return reply({success:false,message:"Wallet funding will be retried."},500);return reply({success:true,message:"Wallet funding processed."});}
        const result = await processPaidOrder(env,eventRef);
        // Missing orders can be a brief race/consistency issue. Ask Paystack
        // to retry rather than acknowledging and permanently dropping the event.
        if (result.status === 404 ||
            (result.status && result.status >= 500) ||
            result.delivery_status === "pending_review" ||
            result.delivery_status === "processing") {
          // Ask Paystack to retry unresolved deliveries. The same MELE
          // reference is reused, so retries are idempotent and cannot double-debit.
          return reply({ success: false, message: "Payment confirmed; delivery is still being reconciled." }, 500);
        }
        return reply({ success: true, message: "Payment event processed." });
      } catch (error) {
        console.error("Paystack webhook processing failed:", error);
        // A non-2xx response asks Paystack to retry the event. The MELE
        // reference is idempotent, so a retry cannot create a duplicate order.
        return reply({ success: false, message: "Payment event processing failed. Please retry." }, 500);
      }
    }


    if (url.pathname === "/api/plans" && request.method === "GET") {
      if (!env.MELE_SECRET_KEY) {
        return reply({ success: false, message: "Data provider is not configured." }, 503);
      }
      try {
        const response = await mele(env, "/data/plans");
        let result;
        try {
          result = await response.json();
        } catch {
          console.error("MELE plans endpoint returned non-JSON response:", response.status);
          return reply({ success: false, message: "Data provider returned an invalid response." }, 502);
        }

        if (!response.ok) {
          console.error("MELE plans request failed:", response.status, result?.message || "No provider message");
          return reply({
            success: false,
            message: "Could not retrieve data plans from the provider."
          }, 502);
        }

        const plans = extractPlans(result);
        return reply({
          success: true,
          plans: plans.map(plan => {
            const providerCost = Number(plan.price);
            return {
              ...plan,
              network: normalizeNetwork(plan.network),
              provider_price: providerCost,
              markup: getMarkup(providerCost),
              customer_price: getSellingPrice(providerCost)
            };
          })
        });
      } catch (error) {
        console.error("MELE plans request error:", error);
        return reply({
          success: false,
          message: "Data plans are temporarily unavailable."
        }, 502);
      }
    }


    if (!env.DB) return reply({success:false,message:"Database is not configured."},503);
    // Private founder administration. Requires ADMIN_EMAIL and ADMIN_PASSWORD Worker secrets/variables.
    if (url.pathname.startsWith("/api/admin/")) {
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        let b; try { b = await request.json(); } catch { return reply({success:false,message:"Invalid request."},400); }
        const suppliedEmail = clean(b.email).toLowerCase();
        if (!(await checkRateLimit(env,request,"admin_login",5,15,suppliedEmail))) return reply({success:false,message:"Too many login attempts. Try again later."},429);
        const configuredEmail = clean(env.ADMIN_EMAIL).toLowerCase();
        const configuredPassword = String(env.ADMIN_PASSWORD || "");
        const suppliedPassword = String(b.password || "");
        if (suppliedEmail.length > 254 || suppliedPassword.length > 256) return reply({success:false,message:"Invalid administrator credentials."},401);
        if (!configuredEmail || configuredPassword.length < 12) return reply({success:false,message:"Admin access has not been configured."},503);
        if (!constantTimeEqual(suppliedEmail,configuredEmail) || !constantTimeEqual(suppliedPassword,configuredPassword)) return reply({success:false,message:"Invalid administrator credentials."},401);
        const token = issueToken();
        await env.DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,datetime('now','+4 hours'))").bind(await hashText(token)).run();
        return reply({success:true,token,expires_in:14400});
      }
      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        const a=request.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7).trim():"";
        if(t.length===64) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await hashText(t)).run();
        return reply({success:true});
      }
      if (!(await adminSession(request,env))) return reply({success:false,message:"Administrator login required."},401);
      if (url.pathname === "/api/admin/me" && request.method === "GET") return reply({success:true,admin:{email:clean(env.ADMIN_EMAIL)}});
      if (url.pathname === "/api/admin/overview" && request.method === "GET") {
        const [customers,orders,paid,delivered,review,wallets,topups] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM customers").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM orders").first(),
          env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM orders WHERE payment_status='success'").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM orders WHERE delivery_status='delivered'").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM orders WHERE delivery_status='pending_review'").first(),
          env.DB.prepare("SELECT COALESCE(SUM(balance_kobo),0) AS total FROM wallets").first(),
          env.DB.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(amount_kobo),0) AS amount FROM wallet_topups WHERE status='credited'").first()
        ]);
        return reply({success:true,stats:{customers:customers.total,orders:orders.total,paid_kobo:paid.total,delivered:delivered.total,pending_review:review.total,wallet_balance_kobo:wallets.total,credited_topups:topups.total,topups_kobo:topups.amount}});
      }
      if (url.pathname === "/api/admin/customers" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT c.id,c.full_name,c.email,c.phone,c.created_at,COALESCE(w.balance_kobo,0) AS balance_kobo FROM customers c LEFT JOIN wallets w ON w.user_id=c.id ORDER BY c.created_at DESC LIMIT 200").all();
        return reply({success:true,customers:rows.results||[]});
      }
      if (url.pathname === "/api/admin/retry-order" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return reply({success:false,message:"Invalid request."},400); }
        const reference = clean(body.reference);
        if (!reference) return reply({success:false,message:"Order reference is required."},400);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE reference = ?").bind(reference).first();
        if (!order) return reply({success:false,message:"Order not found."},404);
        if (order.payment_status !== "success") return reply({success:false,message:"Only paid orders can be retried."},409);
        if (order.delivery_status === "delivered") return reply({success:false,message:"This order is already delivered."},409);

        let previous = {};
        try { previous = JSON.parse(order.provider_response || "{}"); } catch {}
        if (previous.data?.status !== "failed") {
          return reply({success:false,message:"The last provider result is not a confirmed failure. Manual retry is blocked to prevent duplicate delivery."},409);
        }

        const previousRef = String(order.provider_reference || ("ODH_" + reference));
        const retryMatch = previousRef.match(/-R(\d+)$/);
        const retryCount = retryMatch ? Number(retryMatch[1]) : 0;
        if (retryCount >= 2) return reply({success:false,message:"This order has reached its two safe retry attempts. Please review it manually."},409);

        const retryReference = previousRef.replace(/-R\d+$/, "") + "-R" + (retryCount + 1);
        const lock = await env.DB.prepare(
          "UPDATE orders SET delivery_status='processing',updated_at=CURRENT_TIMESTAMP WHERE reference=? AND payment_status='success' AND delivery_status='pending_review'"
        ).bind(reference).run();
        if (!lock.meta.changes) return reply({success:false,message:"This order is already being processed. Refresh the order list shortly."},409);

        try {
          const purchaseResponse = order.service === "data"
            ? await mele(env, "/data/purchase", {method:"POST",body:{
                network:order.network,phone_number:order.phone,plan_id:Number(order.product_id),reference:retryReference
              }})
            : await mele(env, "/airtime/purchase", {method:"POST",body:{
                network:order.network,phone_number:order.phone,amount:Number(order.product_id),reference:retryReference
              }});
          let delivery = {};
          try { delivery = await purchaseResponse.json(); } catch {}
          const delivered = purchaseResponse.ok &&
            (delivery.data?.status === "success" || delivery.data?.status === "delivered");
          await env.DB.prepare(
            "UPDATE orders SET provider_reference=?,provider_response=?,delivery_status=?,updated_at=CURRENT_TIMESTAMP WHERE reference=?"
          ).bind(retryReference,JSON.stringify(delivery).slice(0,5000),delivered?"delivered":"pending_review",reference).run();
          return reply({
            success:delivered,
            reference,
            provider_reference:retryReference,
            delivery_status:delivered?"delivered":"pending_review",
            message:delivered?"Retry successful. Service delivered.":"MELE did not confirm delivery. The order remains under review."
          });
        } catch (error) {
          await env.DB.prepare(
            "UPDATE orders SET provider_reference=?,provider_response=?,delivery_status='pending_review',updated_at=CURRENT_TIMESTAMP WHERE reference=?"
          ).bind(retryReference,JSON.stringify({status:false,message:String(error?.message || "Provider request failed.")}).slice(0,5000),reference).run();
          return reply({success:false,message:"The retry could not be confirmed. The order remains under review; do not retry again immediately."},502);
        }
      }
      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT reference,email,phone,service,network,amount,payment_status,delivery_status,provider_reference,provider_response,created_at FROM orders ORDER BY created_at DESC LIMIT 200").all();
        return reply({success:true,orders:rows.results||[]});
      }
      if (url.pathname === "/api/admin/wallet-activity" && request.method === "GET") {
        const rows = await env.DB.prepare(`
          SELECT * FROM (
            SELECT
              l.reference,
              c.full_name,
              c.email,
              l.type,
              l.amount_kobo,
              l.description,
              l.status,
              l.created_at
            FROM wallet_ledger l
            JOIN customers c ON c.id = l.user_id

            UNION ALL

            SELECT
              o.reference,
              '' AS full_name,
              o.email,
              'order' AS type,
              o.amount AS amount_kobo,
              o.service || ' purchase (' || o.network || ' - ' || o.phone || ')' AS description,
              o.payment_status || ' / ' || o.delivery_status AS status,
              o.created_at
            FROM orders o
          )
          ORDER BY created_at DESC
          LIMIT 300
        `).all();
        return reply({ success: true, activity: rows.results || [] });
      }

      // Marketplace owner controls: protected by the existing sole-admin session.
      if (url.pathname === "/api/admin/marketplace/overview" && request.method === "GET") {
        const [sellers,products,orders,payouts,commission,bankName,accountName,accountNumber,paymentInstructions]=await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM marketplace_sellers").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM marketplace_products").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM marketplace_orders").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM marketplace_payout_requests WHERE status='pending'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='commission_percent'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_bank_name'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_account_name'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_account_number'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_instructions'").first()
        ]);
        return reply({success:true,stats:{sellers:sellers.total,products:products.total,orders:orders.total,pending_payouts:payouts.total,commission_percent:Number(commission?.setting_value||0)},payment_details:{bank_name:bankName?.setting_value||"",account_name:accountName?.setting_value||"",account_number:accountNumber?.setting_value||"",instructions:paymentInstructions?.setting_value||""}});
      }
      if (url.pathname === "/api/admin/marketplace/sellers" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT s.id,s.store_name,s.description,s.bank_name,s.account_name,s.account_number,s.status,s.created_at,c.full_name,c.email,c.phone FROM marketplace_sellers s JOIN customers c ON c.id=s.user_id ORDER BY s.created_at DESC LIMIT 200").all();
        return reply({success:true,sellers:rows.results||[]});
      }
      if (url.pathname === "/api/admin/marketplace/seller-review" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const status=clean(b.status),id=clean(b.sellerId);
        if(!["approved","rejected","suspended"].includes(status)||!id)return reply({success:false,message:"Invalid seller review."},400);
        const result=await env.DB.prepare("UPDATE marketplace_sellers SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status,id).run();
        return result.meta.changes?reply({success:true,message:"Seller status updated."}):reply({success:false,message:"Seller not found."},404);
      }
      if (url.pathname === "/api/admin/marketplace/products" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT p.id,p.title,p.category,p.price_kobo,p.stock_quantity,p.status,p.created_at,s.store_name FROM marketplace_products p JOIN marketplace_sellers s ON s.id=p.seller_id ORDER BY p.created_at DESC LIMIT 250").all();
        return reply({success:true,products:rows.results||[]});
      }
      if (url.pathname === "/api/admin/marketplace/product-review" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const status=clean(b.status),id=clean(b.productId);
        if(!["approved","rejected","archived"].includes(status)||!id)return reply({success:false,message:"Invalid product review."},400);
        const result=await env.DB.prepare("UPDATE marketplace_products SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status,id).run();
        return result.meta.changes?reply({success:true,message:"Product status updated."}):reply({success:false,message:"Product not found."},404);
      }
      if (url.pathname === "/api/admin/marketplace/orders" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT o.id,o.reference,o.quantity,o.total_kobo,o.commission_kobo,o.seller_earning_kobo,o.payment_status,o.status,o.delivery_details,o.buyer_note,o.admin_note,o.created_at,p.title,s.store_name,c.full_name,c.email,c.phone FROM marketplace_orders o JOIN marketplace_products p ON p.id=o.product_id JOIN marketplace_sellers s ON s.id=o.seller_id JOIN customers c ON c.id=o.buyer_id ORDER BY o.created_at DESC LIMIT 250").all();
        return reply({success:true,orders:rows.results||[]});
      }
      if (url.pathname === "/api/admin/marketplace/order-review" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const ref=clean(b.reference),payment=clean(b.paymentStatus),status=clean(b.status);
        if(!ref||!["unpaid","paid","refunded"].includes(payment)||!["requested","accepted","processing","fulfilled","cancelled"].includes(status))return reply({success:false,message:"Invalid order update."},400);
        const order=await env.DB.prepare("SELECT * FROM marketplace_orders WHERE reference=?").bind(ref).first();
        if(!order)return reply({success:false,message:"Order not found."},404);
        if(["accepted","processing","fulfilled"].includes(status)&&payment!=="paid")return reply({success:false,message:"Confirm customer payment before accepting or processing an order."},409);
        if(order.status==="cancelled")return reply({success:false,message:"This order was already cancelled."},409);
        if(order.status==="fulfilled"&&status!=="fulfilled")return reply({success:false,message:"A fulfilled order is closed and cannot be changed."},409);
        if(payment==="refunded"&&order.payment_status!=="paid")return reply({success:false,message:"Only a previously paid order can be marked refunded."},409);
        if(order.payment_status==="paid"&&payment==="unpaid")return reply({success:false,message:"A confirmed payment cannot be changed back to unpaid."},409);
        if(order.payment_status==="refunded"&&payment!=="refunded")return reply({success:false,message:"A refunded order cannot be marked paid again."},409);
        if(status==="cancelled"&&order.payment_status==="paid"&&payment!=="refunded")return reply({success:false,message:"Refund the customer first, then record the refund and cancel the order."},409);
        if(status==="cancelled"&&order.payment_status==="unpaid"&&payment!=="unpaid")return reply({success:false,message:"An unpaid order cannot be recorded as refunded."},409);
        if(payment==="refunded"&&status!=="cancelled")return reply({success:false,message:"Record a refund only when cancelling the order."},409);
        await env.DB.prepare("UPDATE marketplace_orders SET payment_status=?,status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(payment,status,clean(b.adminNote).slice(0,500),ref).run();
        if(status==="cancelled")await env.DB.prepare("UPDATE marketplace_products SET stock_quantity=stock_quantity+? WHERE id=?").bind(order.quantity,order.product_id).run();
        return reply({success:true,message:"Marketplace order updated."});
      }
      if (url.pathname === "/api/admin/marketplace/payouts" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT p.id,p.amount_kobo,p.status,p.payout_reference,p.admin_note,p.created_at,s.store_name,s.bank_name,s.account_name,s.account_number,c.full_name,c.email FROM marketplace_payout_requests p JOIN marketplace_sellers s ON s.id=p.seller_id JOIN customers c ON c.id=s.user_id ORDER BY p.created_at DESC LIMIT 200").all();
        return reply({success:true,payouts:rows.results||[]});
      }
      if (url.pathname === "/api/admin/marketplace/payout-review" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const id=clean(b.payoutId),status=clean(b.status),reference=clean(b.payoutReference);
        if(!id||!["approved","paid","rejected"].includes(status)||(status==="paid"&&!reference))return reply({success:false,message:"A payout reference is required when marking a payout paid."},400);
        const result=await env.DB.prepare("UPDATE marketplace_payout_requests SET status=?,payout_reference=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN('pending','approved')").bind(status,reference,clean(b.adminNote).slice(0,500),id).run();
        return result.meta.changes?reply({success:true,message:"Payout status updated."}):reply({success:false,message:"Payout request not found or already closed."},404);
      }
      if (url.pathname === "/api/admin/marketplace/commission" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const rate=Number(b.percent);
        if(!Number.isFinite(rate)||rate<0||rate>30)return reply({success:false,message:"Commission must be between 0 and 30 percent."},400);
        await env.DB.prepare("INSERT INTO marketplace_settings(setting_key,setting_value,updated_at) VALUES('commission_percent',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(rate)).run();
        return reply({success:true,message:"Marketplace commission updated.",commission_percent:rate});
      }
      if (url.pathname === "/api/admin/marketplace/payment-details" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const bank=clean(b.bankName).slice(0,80),name=clean(b.accountName).slice(0,100),number=clean(b.accountNumber),instructions=clean(b.instructions).slice(0,500);
        if(bank.length<2||name.length<2||!/^\\d{10}$/.test(number))return reply({success:false,message:"Enter a bank name, account name and valid 10-digit account number."},400);
        const entries=[["payment_bank_name",bank],["payment_account_name",name],["payment_account_number",number],["payment_instructions",instructions]];
        await env.DB.batch(entries.map(([key,value])=>env.DB.prepare("INSERT INTO marketplace_settings(setting_key,setting_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(key,value)));
        return reply({success:true,message:"Marketplace payment details saved."});
      }

      return reply({success:false,message:"Admin route not found."},404);
    }


    // Marketplace routes are isolated from the existing data/airtime order and wallet flows.
    if (url.pathname === "/api/marketplace/products" && request.method === "GET") {
      const category = clean(url.searchParams.get("category"));
      const search = clean(url.searchParams.get("q")).slice(0,80);
      const rows = await env.DB.prepare(`
        SELECT p.id,p.title,p.description,p.category,p.price_kobo,p.stock_quantity,p.image_url,p.created_at,s.store_name
        FROM marketplace_products p JOIN marketplace_sellers s ON s.id=p.seller_id
        WHERE p.status='approved' AND s.status='approved' AND p.stock_quantity>0
          AND (?='' OR p.category=?)
          AND (?='' OR p.title LIKE '%'||?||'%' OR p.description LIKE '%'||?||'%')
        ORDER BY p.created_at DESC LIMIT 100
      `).bind(category,category,search,search,search).all();
      return reply({success:true,products:rows.results||[]});
    }

    if (url.pathname.startsWith("/api/marketplace/")) {
      const user = await sessionUser(request,env);
      if (!user) return reply({success:false,message:"Please log in to use the marketplace."},401);
      const seller = await env.DB.prepare("SELECT * FROM marketplace_sellers WHERE user_id=?").bind(user.id).first();

      if (url.pathname === "/api/marketplace/seller/me" && request.method === "GET") {
        return reply({success:true,seller:seller||null});
      }
      if (url.pathname === "/api/marketplace/seller/apply" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const storeName=clean(b.storeName),description=clean(b.description).slice(0,700),bankName=clean(b.bankName),accountName=clean(b.accountName),accountNumber=clean(b.accountNumber);
        if(storeName.length<2||storeName.length>70)return reply({success:false,message:"Store name must be 2–70 characters."},400);
        if(bankName.length<2||bankName.length>80||accountName.length<2||accountName.length>100||!/^\\d{10}$/.test(accountNumber))return reply({success:false,message:"Enter a valid bank name, account name and 10-digit account number."},400);
        if(seller)return reply({success:false,message:"A seller application already exists for this account."},409);
        const slug=storeName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,55)+"-"+crypto.randomUUID().slice(0,6);
        const id=crypto.randomUUID();
        await env.DB.prepare("INSERT INTO marketplace_sellers(id,user_id,store_name,store_slug,description,bank_name,account_name,account_number,status) VALUES(?,?,?,?,?,?,?,?, 'pending')").bind(id,user.id,storeName,slug,description,bankName,accountName,accountNumber).run();
        return reply({success:true,message:"Seller application submitted for owner review.",seller:{id,store_name:storeName,status:"pending"}},201);
      }

      if (url.pathname === "/api/marketplace/orders" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT o.reference,o.quantity,o.total_kobo,o.payment_status,o.status,o.delivery_details,o.created_at,p.title,s.store_name FROM marketplace_orders o JOIN marketplace_products p ON p.id=o.product_id JOIN marketplace_sellers s ON s.id=o.seller_id WHERE o.buyer_id=? ORDER BY o.created_at DESC LIMIT 100").bind(user.id).all();
        return reply({success:true,orders:rows.results||[]});
      }
      if (url.pathname === "/api/marketplace/orders" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const productId=clean(b.productId),quantity=Number(b.quantity),delivery=clean(b.deliveryDetails).slice(0,500),note=clean(b.note).slice(0,500);
        if(!productId||!Number.isInteger(quantity)||quantity<1||quantity>20||delivery.length<8)return reply({success:false,message:"Enter a valid quantity and delivery/contact details."},400);
        const product=await env.DB.prepare("SELECT p.*,s.status AS seller_status FROM marketplace_products p JOIN marketplace_sellers s ON s.id=p.seller_id WHERE p.id=? AND p.status='approved'").bind(productId).first();
        if(!product||product.seller_status!=="approved")return reply({success:false,message:"This product is no longer available."},404);
        if(product.stock_quantity<quantity)return reply({success:false,message:"There is not enough stock for this quantity."},409);
        const total=product.price_kobo*quantity;
        if(!Number.isSafeInteger(total)||total<=0)return reply({success:false,message:"Invalid order amount."},400);
        const setting=await env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='commission_percent'").first();
        const percent=Math.min(30,Math.max(0,Number(setting?.setting_value)||0));
        const commission=Math.round(total*percent/100),earning=total-commission;
        const id=crypto.randomUUID(),reference="OMK_"+crypto.randomUUID().replace(/-/g,"");
        // Reserve stock atomically so concurrent buyers cannot over-order.
        const reserved=await env.DB.prepare("UPDATE marketplace_products SET stock_quantity=stock_quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved' AND stock_quantity>=?").bind(quantity,product.id,quantity).run();
        if(!reserved.meta.changes)return reply({success:false,message:"This item has just sold out. Please refresh the marketplace."},409);
        try {
          await env.DB.prepare("INSERT INTO marketplace_orders(id,reference,buyer_id,seller_id,product_id,quantity,unit_price_kobo,total_kobo,commission_kobo,seller_earning_kobo,delivery_details,buyer_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,reference,user.id,product.seller_id,product.id,quantity,product.price_kobo,total,commission,earning,delivery,note).run();
        } catch(error) {
          await env.DB.prepare("UPDATE marketplace_products SET stock_quantity=stock_quantity+? WHERE id=?").bind(quantity,product.id).run();
          throw error;
        }
        const [bankName,accountName,accountNumber,paymentInstructions]=await Promise.all([
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_bank_name'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_account_name'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_account_number'").first(),
          env.DB.prepare("SELECT setting_value FROM marketplace_settings WHERE setting_key='payment_instructions'").first()
        ]);
        return reply({success:true,message:"Your order request has been sent. Transfer only to the platform account shown below and use your order reference as the payment narration. The owner will verify receipt before the seller can fulfil the order.",reference,total_kobo:total,payment_details:{bank_name:bankName?.setting_value||"",account_name:accountName?.setting_value||"",account_number:accountNumber?.setting_value||"",instructions:paymentInstructions?.setting_value||""}},201);
      }

      if (!seller || seller.status!=="approved") return reply({success:false,message:seller?.status==="pending"?"Your seller application is awaiting approval.":"An approved seller account is required."},403);

      if (url.pathname === "/api/marketplace/seller/products" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT id,title,description,category,price_kobo,stock_quantity,image_url,status,created_at FROM marketplace_products WHERE seller_id=? ORDER BY created_at DESC LIMIT 100").bind(seller.id).all();
        return reply({success:true,products:rows.results||[]});
      }
      if (url.pathname === "/api/marketplace/seller/product-stock" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const id=clean(b.productId),stock=Number(b.stock);
        if(!id||!Number.isInteger(stock)||stock<0||stock>100000)return reply({success:false,message:"Enter a valid stock quantity."},400);
        const result=await env.DB.prepare("UPDATE marketplace_products SET stock_quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND seller_id=? AND status IN('pending','approved')").bind(stock,id,seller.id).run();
        return result.meta.changes?reply({success:true,message:"Product stock updated."}):reply({success:false,message:"Product not found or no longer editable."},404);
      }
      if (url.pathname === "/api/marketplace/seller/product-archive" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const id=clean(b.productId);
        if(!id)return reply({success:false,message:"Product is required."},400);
        const result=await env.DB.prepare("UPDATE marketplace_products SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE id=? AND seller_id=? AND status IN('pending','approved','rejected')").bind(id,seller.id).run();
        return result.meta.changes?reply({success:true,message:"Product archived and removed from the public catalogue."}):reply({success:false,message:"Product not found or already archived."},404);
      }
      if (url.pathname === "/api/marketplace/seller/products" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const title=clean(b.title),description=clean(b.description),category=clean(b.category),price=Math.round(Number(b.priceNaira)*100),stock=Number(b.stock),image=clean(b.imageUrl);
        if(title.length<3||title.length>100||description.length<10||description.length>2500||category.length<2||category.length>50||!Number.isSafeInteger(price)||price<10000||price>100000000||!Number.isInteger(stock)||stock<0||stock>100000)return reply({success:false,message:"Check the product details, price and stock quantity."},400);
        if(image && (!/^https:\/\//i.test(image)||image.length>1000))return reply({success:false,message:"Product image must use a valid HTTPS link."},400);
        const id=crypto.randomUUID();
        await env.DB.prepare("INSERT INTO marketplace_products(id,seller_id,title,description,category,price_kobo,stock_quantity,image_url,status) VALUES(?,?,?,?,?,?,?,?,'pending')").bind(id,seller.id,title,description,category,price,stock,image).run();
        return reply({success:true,message:"Product submitted for owner approval.",product_id:id},201);
      }
      if (url.pathname === "/api/marketplace/seller/orders" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT o.id,o.reference,o.quantity,o.total_kobo,o.commission_kobo,o.seller_earning_kobo,o.payment_status,o.status,o.delivery_details,o.buyer_note,o.created_at,p.title,c.full_name,c.phone FROM marketplace_orders o JOIN marketplace_products p ON p.id=o.product_id JOIN customers c ON c.id=o.buyer_id WHERE o.seller_id=? ORDER BY o.created_at DESC LIMIT 100").bind(seller.id).all();
        return reply({success:true,orders:rows.results||[]});
      }
      if (url.pathname === "/api/marketplace/seller/order-status" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const reference=clean(b.reference),status=clean(b.status);
        if(!["accepted","processing","fulfilled","cancelled"].includes(status))return reply({success:false,message:"Invalid order status."},400);
        const order=await env.DB.prepare("SELECT payment_status,status FROM marketplace_orders WHERE reference=? AND seller_id=?").bind(reference,seller.id).first();
        if(!order)return reply({success:false,message:"Order not found."},404);
        if(["accepted","processing","fulfilled"].includes(status)&&order.payment_status!=="paid")return reply({success:false,message:"The owner must confirm payment before you can accept or process this order."},409);
        if(order.status==="cancelled"||order.status==="fulfilled")return reply({success:false,message:"This order can no longer be changed."},409);
        if(status==="cancelled"&&order.payment_status==="paid")return reply({success:false,message:"Paid orders must be cancelled by the platform owner so refunds can be reviewed."},409);
        await env.DB.prepare("UPDATE marketplace_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE reference=? AND seller_id=?").bind(status,reference,seller.id).run();
        if(status==="cancelled")await env.DB.prepare("UPDATE marketplace_products SET stock_quantity=stock_quantity+(SELECT quantity FROM marketplace_orders WHERE reference=?) WHERE id=(SELECT product_id FROM marketplace_orders WHERE reference=?)").bind(reference,reference).run();
        return reply({success:true,message:"Order status updated."});
      }
      if (url.pathname === "/api/marketplace/seller/payout-request" && request.method === "POST") {
        let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const amount=Math.round(Number(b.amountNaira)*100);
        if(!Number.isSafeInteger(amount)||amount<10000)return reply({success:false,message:"Minimum payout request is ₦100."},400);
        const earned=await env.DB.prepare("SELECT COALESCE(SUM(seller_earning_kobo),0) AS total FROM marketplace_orders WHERE seller_id=? AND payment_status='paid' AND status='fulfilled'").bind(seller.id).first();
        const paid=await env.DB.prepare("SELECT COALESCE(SUM(amount_kobo),0) AS total FROM marketplace_payout_requests WHERE seller_id=? AND status IN('approved','paid')").bind(seller.id).first();
        const pending=await env.DB.prepare("SELECT COALESCE(SUM(amount_kobo),0) AS total FROM marketplace_payout_requests WHERE seller_id=? AND status='pending'").bind(seller.id).first();
        const available=(earned?.total||0)-(paid?.total||0)-(pending?.total||0);
        if(amount>available)return reply({success:false,message:"Payout request exceeds your available earnings."},409);
        await env.DB.prepare("INSERT INTO marketplace_payout_requests(id,seller_id,amount_kobo) VALUES(?,?,?)").bind(crypto.randomUUID(),seller.id,amount).run();
        return reply({success:true,message:"Payout request sent to the platform owner."},201);
      }
      if (url.pathname === "/api/marketplace/seller/payouts" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT id,amount_kobo,status,payout_reference,admin_note,created_at FROM marketplace_payout_requests WHERE seller_id=? ORDER BY created_at DESC LIMIT 50").bind(seller.id).all();
        return reply({success:true,payouts:rows.results||[]});
      }
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      if (!(await checkRateLimit(env,request,"customer_register",5,60))) return reply({success:false,message:"Too many registration attempts. Try again later."},429);
      let b;
      try {
        b = await request.json();
      } catch {
        return reply({ success: false, message: "Invalid request." }, 400);
      }

      const name = clean(b.fullName);
      const email = clean(b.email).toLowerCase();
      const phone = clean(b.phone);
      const password = String(b.password || "");

      if (
        name.length < 2 ||
        name.length > 80 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !validPhone(phone) ||
        password.length < 10 ||
        password.length > 128
      ) {
        return reply({
          success: false,
          message: "Enter your name, valid email and phone, and a password of at least 10 characters."
        }, 400);
      }

      try {
        // Keep every database operation inside this try block so D1 errors
        // are returned with the configured CORS headers instead of becoming
        // an opaque browser-level "Failed to fetch" response.
        const existing = await env.DB.prepare(
          "SELECT id FROM customers WHERE email = ?"
        ).bind(email).first();

        if (existing) {
          return reply({
            success: false,
            message: "Email already registered. Please log in."
          }, 409);
        }

        const id = crypto.randomUUID();
        const passwordData = await securePassword(password);
        const token = issueToken();
        const tokenHash = await hashText(token);

        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO customers(id,full_name,email,phone,password_hash,password_salt) VALUES(?,?,?,?,?,?)"
          ).bind(id, name, email, phone, passwordData.hash, passwordData.salt),
          env.DB.prepare(
            "INSERT INTO wallets(user_id,balance_kobo) VALUES(?,0)"
          ).bind(id),
          env.DB.prepare(
            "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))"
          ).bind(id, tokenHash)
        ]);

        return reply({
          success: true,
          token,
          user: { id, full_name: name, email, phone }
        });
      } catch (error) {
        console.error("Customer registration failed:", error);
        const message = String(error?.message || "").toLowerCase();
        if (message.includes("unique") || message.includes("constraint")) {
          return reply({
            success: false,
            message: "Email already registered. Please log in."
          }, 409);
        }
        return reply({
          success: false,
          message: "Registration could not be completed. Please try again."
        }, 500);
      }
    }
    if(url.pathname==="/api/auth/login"&&request.method==="POST"){
      let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
      const loginEmail=clean(b.email).toLowerCase();
      if (!(await checkRateLimit(env,request,"customer_login",10,15,loginEmail))) return reply({success:false,message:"Too many login attempts. Try again later."},429);
      const u=await env.DB.prepare("SELECT * FROM customers WHERE email=?").bind(loginEmail).first(),password=String(b.password||"");
      if(!u||password.length>128)return reply({success:false,message:"Email or password is incorrect."},401);
      const p=await securePassword(password,u.password_salt);if(!constantTimeEqual(p.hash,u.password_hash))return reply({success:false,message:"Email or password is incorrect."},401);
      const token=issueToken();await env.DB.prepare("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").bind(u.id,await hashText(token)).run();return reply({success:true,token,user:{id:u.id,full_name:u.full_name,email:u.email,phone:u.phone}});
    }
    if(url.pathname==="/api/auth/me"&&request.method==="GET"){const u=await sessionUser(request,env);return u?reply({success:true,user:u}):reply({success:false,message:"Please log in again."},401)}
    if(url.pathname==="/api/auth/logout"&&request.method==="POST"){const a=request.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7).trim():"";if(t.length===64)await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await hashText(t)).run();return reply({success:true})}
    if(url.pathname==="/api/wallet"||url.pathname.startsWith("/api/wallet/")){
      const u=await sessionUser(request,env);if(!u)return reply({success:false,message:"Please log in to use your wallet."},401);
      if(url.pathname==="/api/wallet"&&request.method==="GET"){const b=await env.DB.prepare("SELECT balance_kobo FROM wallets WHERE user_id=?").bind(u.id).first(),l=await env.DB.prepare("SELECT reference,type,amount_kobo,description,status,created_at FROM wallet_ledger WHERE user_id=? ORDER BY id DESC LIMIT 40").bind(u.id).all();return reply({success:true,balance_kobo:b?.balance_kobo||0,transactions:l.results||[]})}
      if(url.pathname==="/api/wallet/initialize-topup"&&request.method==="POST"){
        if(!env.PAYSTACK_SECRET_KEY)return reply({success:false,message:"Paystack is not configured."},503);let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}const amount=Number(b.amount);if(!Number.isInteger(amount)||amount<500||amount>100000)return reply({success:false,message:"Enter ₦500 to ₦100,000."},400);
        const ref="WAL_"+crypto.randomUUID().replace(/-/g,"");await env.DB.prepare("INSERT INTO wallet_topups(reference,user_id,amount_kobo,status) VALUES(?,?,?,'pending')").bind(ref,u.id,money(amount)).run();
        try{const r=await fetch(PAYSTACK_BASE+"/transaction/initialize",{method:"POST",headers:{Authorization:"Bearer "+env.PAYSTACK_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({email:u.email,amount:money(amount),currency:"NGN",reference:ref,callback_url:"https://orikaezedatahub.github.io/orikaeze-data-hub/account.html",metadata:{type:"wallet_funding",user_id:u.id,reference:ref}})}),d=await r.json();if(!r.ok||!d.status){await env.DB.prepare("UPDATE wallet_topups SET status='initialization_failed' WHERE reference=?").bind(ref).run();return reply({success:false,message:"Could not initialize payment."},502)}return reply({success:true,reference:ref,authorization_url:d.data.authorization_url})}catch{return reply({success:false,message:"Could not start wallet funding."},502)}
      }
      if(url.pathname==="/api/wallet/verify-topup"&&request.method==="POST"){let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}const ref=clean(b.reference),own=await env.DB.prepare("SELECT reference FROM wallet_topups WHERE reference=? AND user_id=?").bind(ref,u.id).first();if(!own)return reply({success:false,message:"Deposit not found."},404);try{const d=await settleWalletTopup(env,ref);return reply(d,d.status||200)}catch{return reply({success:false,message:"Payment is still being confirmed. Do not pay again."},502)}}
      if(url.pathname==="/api/wallet/purchase"&&request.method==="POST"){
        if(!env.MELE_SECRET_KEY)return reply({success:false,message:"Service provider is not configured."},503);let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const service=clean(b.service).toLowerCase(),network=normalizeNetwork(b.network),phone=clean(b.phone),product=clean(b.productId),face=Number(b.amount);if(!validPhone(phone)||!["data","airtime"].includes(service)||!["MTN","GLO","AIRTEL","9MOBILE"].includes(network))return reply({success:false,message:"Check service, network and phone number."},400);
        try{await getLiveStatus(env)}catch{return reply({success:false,message:"Live delivery is unavailable."},503)}
        let cost,plan=null;if(service==="data"){const r=await mele(env,"/data/plans"),d=await r.json(),p=extractPlans(d).find(x=>String(x.plan_id)===product&&normalizeNetwork(x.network)===network);if(!r.ok||!p)return reply({success:false,message:"Selected plan unavailable."},400);cost=Number(p.price);plan=p.plan_id}else{if(!Number.isInteger(face)||face<100||face>100000)return reply({success:false,message:"Airtime must be ₦100–₦100,000."},400);cost=face}
        if(!Number.isFinite(cost)||cost<=0)return reply({success:false,message:"Invalid product price."},400);const customerPrice=service==="data"?getSellingPrice(cost):cost;if(!Number.isFinite(customerPrice)||customerPrice<=0)return reply({success:false,message:"Invalid product price."},400);const amount=money(customerPrice),ref="WPO_"+crypto.randomUUID().replace(/-/g,"");
        const tx=await env.DB.batch([env.DB.prepare("INSERT INTO wallet_orders(reference,user_id,service,network,phone,product_id,amount_kobo,status) SELECT ?,?,?,?,?,?,?,'processing' WHERE EXISTS(SELECT 1 FROM wallets WHERE user_id=? AND balance_kobo>=?)").bind(ref,u.id,service,network,phone,plan===null?String(face):String(plan),amount,u.id,amount),env.DB.prepare("UPDATE wallets SET balance_kobo=balance_kobo-?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND balance_kobo>=? AND EXISTS(SELECT 1 FROM wallet_orders WHERE reference=?)").bind(amount,u.id,amount,ref),env.DB.prepare("INSERT INTO wallet_ledger(user_id,reference,type,amount_kobo,description,status) SELECT ?,?,'debit',?,?,'pending' WHERE EXISTS(SELECT 1 FROM wallet_orders WHERE reference=?)").bind(u.id,ref,amount,service+" purchase",ref)]);
        if(!tx[0].meta.changes)return reply({success:false,message:"Insufficient wallet balance. Please fund your wallet."},400);
        const pref="ODH_"+ref;let pr,d={};try{pr=service==="data"?await mele(env,"/data/purchase",{method:"POST",body:{network,phone_number:phone,plan_id:Number(plan),reference:pref}}):await mele(env,"/airtime/purchase",{method:"POST",body:{network,phone_number:phone,amount:face,reference:pref}});try{d=await pr.json()}catch{}}catch{await env.DB.prepare("UPDATE wallet_orders SET status='pending_review',provider_reference=? WHERE reference=?").bind(pref,ref).run();return reply({success:false,reference:ref,message:"Provider response pending. Do not buy again; contact support if it does not update."},202)}
        if(pr.ok&&(d.data?.status==="success"||d.data?.status==="delivered")){await env.DB.batch([env.DB.prepare("UPDATE wallet_orders SET status='delivered',provider_reference=?,provider_response=?,updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(pref,JSON.stringify(d).slice(0,3000),ref),env.DB.prepare("UPDATE wallet_ledger SET status='success' WHERE reference=?").bind(ref)]);return reply({success:true,reference:ref,message:"Purchase successful and delivered."})}
        if(pr.status>=500||pr.status===408||pr.status===429){await env.DB.prepare("UPDATE wallet_orders SET status='pending_review',provider_reference=?,provider_response=? WHERE reference=?").bind(pref,JSON.stringify(d).slice(0,3000),ref).run();return reply({success:false,reference:ref,message:"Provider is still confirming. Do not purchase again."},202)}
        await refundWalletPurchase(env,{reference:ref,user_id:u.id,amount_kobo:amount},JSON.stringify(d));return reply({success:false,reference:ref,message:"Purchase failed. Amount returned to wallet."},502)
      }
    }

    if (!env.DB || !env.PAYSTACK_SECRET_KEY || !env.MELE_SECRET_KEY) {
      return reply({
        success: false,
        message: "Backend configuration is incomplete."
      }, 503);
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

      const markup = service === "data" ? getMarkup(providerCost) : 0;
      const customerAmount = service === "data" ? getSellingPrice(providerCost) : providerCost;

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
    } catch (error) {
      console.error("Unhandled Worker error:", error);
      const origin = request.headers.get("Origin") || "";
      const allowedOrigin = env.ALLOWED_ORIGIN || "https://orikaezedatahub.github.io";
      return json({
        success: false,
        message: "The backend encountered an unexpected error."
      }, 500, origin && origin === allowedOrigin ? allowedOrigin : allowedOrigin);
    }
  }
};
