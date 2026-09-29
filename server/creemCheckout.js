const crypto = require("crypto");

// ============================================================
// GET /checkout — Creem checkout session-ის შექმნა
//
// ნაკადი:
//   საიტის "Get 7-Day Pass" ღილაკი → GET /checkout?email=...&uid=...
//   → აქ ვქმნით Creem checkout session-ს (API key მხოლოდ backend-ზეა)
//   → 302 redirect Creem-ის hosted checkout გვერდზე.
//
// რატომ redirect და არა fetch: საიტს CORS header-ები არ სჭირდება
// და API key ბრაუზერში არასოდეს ხვდება.
//
// email/uid არჩევითია. თუ email არ არის, მყიდველი მას Creem-ის
// checkout-ზე თავად შეიყვანს. Pass-ი webhook-ში customer.email-ზე
// მიეწერება (იხ. creemWebhook.js), ამიტომ email ყოველთვის ცნობილია.
// ============================================================

const CREEM_API_KEY = process.env.CREEM_API_KEY;
const CREEM_PRODUCT_ID = process.env.CREEM_PRODUCT_ID;
const CREEM_API_BASE = (
  process.env.CREEM_API_BASE || "https://test-api.creem.io"
).replace(/\/+$/, "");

// საიტი, სადაც გადახდის შემდეგ (ან შეცდომისას) ვაბრუნებთ მომხმარებელს.
const SITE_URL = (
  process.env.CHECKOUT_SITE_URL || "https://georgiatravelaiguide.com"
).replace(/\/+$/, "");

const SUCCESS_URL = `${SITE_URL}/?status=complete`;
const ERROR_URL = `${SITE_URL}/?checkout_error=1`;

// ------------------------------------------------------------
// მარტივი in-memory rate limit IP-ზე (checkout session-ების
// სპამისგან დაცვა). Railway-ზე ერთი instance გვაქვს, ამიტომ
// in-memory საკმარისია.
// ------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

// ძველი ჩანაწერების გასუფთავება, რომ Map უსასრულოდ არ გაიზარდოს.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateBuckets.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isPlausibleEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
}

async function handleCreemCheckout(req, res) {
  if (!CREEM_API_KEY || !CREEM_PRODUCT_ID) {
    console.error(
      "Creem checkout: CREEM_API_KEY or CREEM_PRODUCT_ID is not set",
    );
    redirect(res, ERROR_URL);
    return;
  }

  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    console.warn(`Creem checkout: rate limited ${ip}`);
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Too many requests. Please wait a minute and try again.");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const rawEmail = (url.searchParams.get("email") || "").trim();
  const rawUid = (url.searchParams.get("uid") || "").trim();

  const email = isPlausibleEmail(rawEmail) ? rawEmail.toLowerCase() : null;
  // uid მხოლოდ ინფორმაციისთვის ინახება metadata-ში (Pass email-ზე
  // მიეწერება). Firebase uid-ები ალფანუმერულია, სიგრძე ≤ 128.
  const uid = /^[A-Za-z0-9_-]{1,128}$/.test(rawUid) ? rawUid : null;

  const requestId = `gtg_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

  const body = {
    product_id: CREEM_PRODUCT_ID,
    request_id: requestId,
    success_url: SUCCESS_URL,
    metadata: {
      source: "web",
      ...(uid ? { app_user_id: uid } : {}),
    },
    ...(email ? { customer: { email } } : {}),
  };

  try {
    const response = await fetch(`${CREEM_API_BASE}/v1/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CREEM_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `Creem checkout: API error ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`,
      );
      redirect(res, ERROR_URL);
      return;
    }

    const checkout = await response.json();

    if (!checkout?.checkout_url) {
      console.error("Creem checkout: response has no checkout_url");
      redirect(res, ERROR_URL);
      return;
    }

    console.log(
      `Creem checkout: session ${checkout.id || "?"} created (request ${requestId}` +
        (email ? `, email prefilled` : "") +
        ")",
    );

    redirect(res, checkout.checkout_url);
  } catch (error) {
    console.error("Creem checkout: request failed:", error.message);
    redirect(res, ERROR_URL);
  }
}

module.exports = { handleCreemCheckout };
