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


async function hashText(v){const x=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(x)].map(b=>b.toString(16).padStart(2,"0")).join("")}
function issueToken(){return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function securePassword(v,s){const salt=s?Uint8Array.from(s.match(/.{2}/g),x=>parseInt(x,16)):crypto.getRandomValues(new Uint8Array(16));const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(v),"PBKDF2",false,["deriveBits"]);const b=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:310000,hash:"SHA-256"},k,256);return{salt:[...salt].map(x=>x.toString(16).padStart(2,"0")).join(""),hash:[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}}
async function sessionUser(req,env){const a=req.headers.get("Authorization")||"",t=a.startsWith("Bearer ")?a.slice(7).trim():"";if(t.length!==64)return null;return env.DB.prepare("SELECT c.id,c.full_name,c.email,c.phone FROM auth_sessions s JOIN customers c ON c.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP").bind(await hashText(t)).first()}
async function settleWalletTopup(env,ref){const t=await env.DB.prepare("SELECT * FROM wallet_topups WHERE reference=?").bind(ref).first();if(!t)return{success:false,status:404,message:"Deposit not found."};if(t.status==="credited")return{success:true,message:"Wallet already credited."};const r=await paystack(env,"/transaction/verify/"+encodeURIComponent(ref)),v=await r.json();if(!r.ok||!v.status)throw Error("Paystack verification unavailable");if(v.data?.status!=="success")throw Error("Payment not confirmed");if(v.data?.currency!=="NGN"||Number(v.data?.amount)!==t.amount_kobo||v.data?.reference!==ref)return{success:false,status:400,message:"Payment details do not match."};await env.DB.batch([env.DB.prepare("UPDATE wallets SET balance_kobo=balance_kobo+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(t.amount_kobo,t.user_id,ref),env.DB.prepare("INSERT INTO wallet_ledger(user_id,reference,type,amount_kobo,description,status) SELECT ?,?,'credit',?,'Wallet funding via Paystack','success' WHERE NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(t.user_id,ref,t.amount_kobo,ref),env.DB.prepare("UPDATE wallet_topups SET status='credited',updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(ref)]);return{success:true,message:"Wallet funded successfully."}}
async function refundWalletPurchase(env,p,detail){const ref="REF_"+p.reference;await env.DB.batch([env.DB.prepare("UPDATE wallets SET balance_kobo=balance_kobo+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(p.amount_kobo,p.user_id,ref),env.DB.prepare("INSERT INTO wallet_ledger(user_id,reference,type,amount_kobo,description,status) SELECT ?,?,'credit',?,'Refund for failed purchase','success' WHERE NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE reference=?)").bind(p.user_id,ref,p.amount_kobo,ref),env.DB.prepare("UPDATE wallet_orders SET status='refunded',provider_response=?,updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(String(detail).slice(0,3000),p.reference),env.DB.prepare("UPDATE wallet_ledger SET status='refunded' WHERE reference=?").bind(p.reference)])}

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


    if (!env.DB) return reply({success:false,message:"Database is not configured."},503);
    if(url.pathname==="/api/auth/register"&&request.method==="POST"){
      let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
      const name=clean(b.fullName),email=clean(b.email).toLowerCase(),phone=clean(b.phone),password=String(b.password||"");
      if(name.length<2||name.length>80||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!validPhone(phone)||password.length<10||password.length>128)return reply({success:false,message:"Enter your name, valid email and phone, and a password of at least 10 characters."},400);
      if(await env.DB.prepare("SELECT id FROM customers WHERE email=?").bind(email).first())return reply({success:false,message:"Email already registered. Please log in."},409);
      const id=crypto.randomUUID(),p=await securePassword(password),token=issueToken();
      try{await env.DB.batch([env.DB.prepare("INSERT INTO customers(id,full_name,email,phone,password_hash,password_salt) VALUES(?,?,?,?,?,?)").bind(id,name,email,phone,p.hash,p.salt),env.DB.prepare("INSERT INTO wallets(user_id,balance_kobo) VALUES(?,0)").bind(id),env.DB.prepare("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").bind(id,await hashText(token))]);return reply({success:true,token,user:{id,full_name:name,email,phone}})}catch(e){console.error(e);return reply({success:false,message:"Could not create account. Email may already exist."},409)}
    }
    if(url.pathname==="/api/auth/login"&&request.method==="POST"){
      let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
      const u=await env.DB.prepare("SELECT * FROM customers WHERE email=?").bind(clean(b.email).toLowerCase()).first(),password=String(b.password||"");
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
        try{const r=await fetch(PAYSTACK_BASE+"/transaction/initialize",{method:"POST",headers:{Authorization:"Bearer "+env.PAYSTACK_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({email:u.email,amount:money(amount),currency:"NGN",reference:ref,callback_url:env.PAYSTACK_CALLBACK_URL||"https://orikaezedatahub.github.io/orikaeze-data-hub/account.html",metadata:{type:"wallet_funding",user_id:u.id,reference:ref}})}),d=await r.json();if(!r.ok||!d.status){await env.DB.prepare("UPDATE wallet_topups SET status='initialization_failed' WHERE reference=?").bind(ref).run();return reply({success:false,message:"Could not initialize payment."},502)}return reply({success:true,reference:ref,authorization_url:d.data.authorization_url})}catch{return reply({success:false,message:"Could not start wallet funding."},502)}
      }
      if(url.pathname==="/api/wallet/verify-topup"&&request.method==="POST"){let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}const ref=clean(b.reference),own=await env.DB.prepare("SELECT reference FROM wallet_topups WHERE reference=? AND user_id=?").bind(ref,u.id).first();if(!own)return reply({success:false,message:"Deposit not found."},404);try{const d=await settleWalletTopup(env,ref);return reply(d,d.status||200)}catch{return reply({success:false,message:"Payment is still being confirmed. Do not pay again."},502)}}
      if(url.pathname==="/api/wallet/purchase"&&request.method==="POST"){
        if(!env.MELE_SECRET_KEY)return reply({success:false,message:"Service provider is not configured."},503);let b;try{b=await request.json()}catch{return reply({success:false,message:"Invalid request."},400)}
        const service=clean(b.service).toLowerCase(),network=normalizeNetwork(b.network),phone=clean(b.phone),product=clean(b.productId),face=Number(b.amount);if(!validPhone(phone)||!["data","airtime"].includes(service)||!["MTN","GLO","AIRTEL","9MOBILE"].includes(network))return reply({success:false,message:"Check service, network and phone number."},400);
        try{await getLiveStatus(env)}catch{return reply({success:false,message:"Live delivery is unavailable."},503)}
        let cost,plan=null;if(service==="data"){const r=await mele(env,"/data/plans"),d=await r.json(),p=extractPlans(d).find(x=>String(x.plan_id)===product&&normalizeNetwork(x.network)===network);if(!r.ok||!p)return reply({success:false,message:"Selected plan unavailable."},400);cost=Number(p.price);plan=p.plan_id}else{if(!Number.isInteger(face)||face<100||face>100000)return reply({success:false,message:"Airtime must be ₦100–₦100,000."},400);cost=face}
        const amount=money(Math.ceil(cost+Math.max(0,Number(env.PROFIT_NAIRA||0)))),ref="WPO_"+crypto.randomUUID().replace(/-/g,"");
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
