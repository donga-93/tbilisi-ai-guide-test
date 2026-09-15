const crypto = require("crypto");

const { grantTripPassFromWebhook } = require("./auth");

// ============================================================
// Paddle webhook handler
//
// Paddle POST-ავს ამ endpoint-ზე ტრანზაქციის ცვლილებებზე. ჩვენთვის
// რელევანტურია მხოლოდ "transaction.completed" — მასზე ვწერთ
// Firestore-ის pendingPasses/{email} დოკუმენტს (7-დღიანი Trip
// Pass), რომელსაც მომხმარებელი მოგვიანებით, sign-in-ის შემდეგ,
// "იჩემებს" — იხ. auth.js-ის claimPendingPass და server.js-ის
// POST /claim-pass.
// ============================================================

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_API_BASE_URL =
  process.env.PADDLE_API_BASE_URL || "https://api.paddle.com";

// ------------------------------------------------------------
// Paddle-Signature ვერიფიკაცია
//
// ფორმატი: "ts=<unix_timestamp>;h1=<hex_hmac>". Signed payload
// აიგება როგორც `${ts}:${rawBody}`, HMAC-SHA256-ით
// PADDLE_WEBHOOK_SECRET-ის გამოყენებით.
// https://developer.paddle.com/webhooks/about/signature-verification/
// ------------------------------------------------------------
function verifyPaddleSignature(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET || !signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(";");
  if (parts.length !== 2) {
    return false;
  }

  const [tsPart, h1Part] = parts.map((part) => part.split("=")[1]);
  if (!tsPart || !h1Part) {
    return false;
  }

  const signedPayload = `${tsPart}:${rawBody}`;
  const computedHash = crypto
    .createHmac("sha256", PADDLE_WEBHOOK_SECRET)
    .update(signedPayload, "utf8")
    .digest("hex");

  const computedBuffer = Buffer.from(computedHash, "utf8");
  const receivedBuffer = Buffer.from(h1Part, "utf8");

  // სიგრძეები უნდა ემთხვეოდეს timingSafeEqual-ის გამოძახებამდე —
  // წინააღმდეგ შემთხვევაში ის თავად ისვრის.
  if (computedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, receivedBuffer);
}

// ------------------------------------------------------------
// customer_id-დან email-ის ამოღება Paddle API-დან
//
// transaction.completed webhook payload-ს (data) აქვს მხოლოდ
// customer_id (ctm_...) — არა embedded customer.email — ამიტომ
// საჭიროა ცალკე GET /customers/{customer_id} მოთხოვნა.
// https://developer.paddle.com/api-reference/customers/get-customer/
// ------------------------------------------------------------
async function fetchCustomerEmail(customerId) {
  if (!PADDLE_API_KEY) {
    throw new Error("PADDLE_API_KEY is not set — cannot look up customer email");
  }

  const response = await fetch(
    `${PADDLE_API_BASE_URL}/customers/${customerId}`,
    {
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Paddle customer lookup failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json();
  return body?.data?.email || null;
}

async function processTransactionCompleted(data) {
  if (!data || typeof data !== "object") {
    console.warn(
      "Paddle webhook: transaction.completed has no data object, ignoring",
    );
    return;
  }

  const transactionId = data.id;

  if (!transactionId) {
    console.warn("Paddle webhook: transaction.completed has no id, ignoring");
    return;
  }

  // data.customer?.email მხოლოდ ხელს არ გვირღვევს მომავალში, თუ Paddle
  // ოდესმე დაამატებს embedded customer object-ს — ამჟამად ეს ველი
  // transaction.completed payload-ში არ არსებობს, მხოლოდ customer_id.
  let email = data.customer?.email || null;

  if (!email && data.customer_id) {
    email = await fetchCustomerEmail(data.customer_id);
  }

  if (!email) {
    console.warn(
      `Paddle webhook: could not resolve customer email for transaction ${transactionId}, ignoring`,
    );
    return;
  }

  await grantTripPassFromWebhook(email, transactionId);

  console.log(
    `Paddle webhook: transaction.completed processed for ${email} (${transactionId})`,
  );
}

// ------------------------------------------------------------
// HTTP request handler (server.js-იდან გამოძახებული)
// ------------------------------------------------------------
function handlePaddleWebhook(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;

    // Basic DoS-guard, RevenueCat webhook-ის ანალოგიურად.
    if (body.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    const signatureHeader = req.headers["paddle-signature"];

    if (!verifyPaddleSignature(body, signatureHeader)) {
      console.warn(
        "Paddle webhook: invalid or missing Paddle-Signature header",
      );
      res.writeHead(401);
      res.end();
      return;
    }

    let payload;

    try {
      payload = JSON.parse(body);
    } catch (error) {
      console.error("Paddle webhook: invalid JSON:", error.message);
      res.writeHead(400);
      res.end();
      return;
    }

    if (payload.event_type !== "transaction.completed") {
      // სხვა event type-ები ამჟამად ჩვენთვის არარელევანტურია — 200-ს
      // ვაბრუნებთ, რომ Paddle-მა აღარ სცადოს retry.
      res.writeHead(200);
      res.end("OK");
      return;
    }

    try {
      await processTransactionCompleted(payload.data);

      res.writeHead(200);
      res.end("OK");
    } catch (error) {
      console.error("Paddle webhook processing failed:", error.message);

      // 500-ის დაბრუნება იმისთვის, რომ Paddle-მა ავტომატურად სცადოს
      // retry (Paddle retries on non-2xx responses).
      res.writeHead(500);
      res.end();
    }
  });
}

module.exports = { handlePaddleWebhook };
