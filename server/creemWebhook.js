const crypto = require("crypto");

const { grantTripPassFromWebhook } = require("./auth");

// ============================================================
// POST /creem-webhook — Creem webhook handler
//
// Creem POST-ავს ამ endpoint-ზე event-ებს. ჩვენთვის მთავარია
// "checkout.completed": მასზე ვწერთ pendingPasses/{email}-ს
// (7-დღიანი Trip Pass), რომელსაც მომხმარებელი sign-in-ის შემდეგ
// "იჩემებს" (auth.js → claimPendingPass, server.js → POST /claim-pass).
//
// ხელმოწერა: header "creem-signature" = HMAC-SHA256(raw body)
// hex-ში, CREEM_WEBHOOK_SECRET-ით.
// https://docs.creem.io/code/webhooks
//
// Creem ხელახლა აგზავნის (retry) ნებისმიერ არა-2xx პასუხზე,
// ამიტომ დამუშავების შეცდომაზე 500-ს ვაბრუნებთ, ხოლო
// იდემპოტენტურობას auth.js-ის processedPayments უზრუნველყოფს.
// ============================================================

const CREEM_WEBHOOK_SECRET = process.env.CREEM_WEBHOOK_SECRET;
const CREEM_PRODUCT_ID = process.env.CREEM_PRODUCT_ID;

const MAX_BODY_BYTES = 1_000_000;

// ------------------------------------------------------------
// ხელმოწერის შემოწმება (timing-safe)
// ------------------------------------------------------------
function verifyCreemSignature(rawBodyBuffer, signatureHeader) {
  if (!CREEM_WEBHOOK_SECRET || !signatureHeader) {
    return false;
  }

  const received = String(signatureHeader).trim().toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(received)) {
    return false;
  }

  const computed = crypto
    .createHmac("sha256", CREEM_WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(received, "hex"),
  );
}

// ------------------------------------------------------------
// checkout.completed
// ------------------------------------------------------------
async function processCheckoutCompleted(checkout) {
  if (!checkout || typeof checkout !== "object") {
    console.warn("Creem webhook: checkout.completed has no object, ignoring");
    return;
  }

  const order = checkout.order && typeof checkout.order === "object" ? checkout.order : null;
  const orderId = order?.id || null;
  const checkoutId = checkout.id || null;

  // Idempotency key: order id (ერთ გადახდაზე ერთი), fallback checkout id.
  const paymentId = orderId || checkoutId;

  if (!paymentId) {
    console.warn("Creem webhook: checkout.completed has no order/checkout id, ignoring");
    return;
  }

  if (order && order.status && order.status !== "paid") {
    console.warn(
      `Creem webhook: order ${orderId} status is "${order.status}", not "paid" — ignoring`,
    );
    return;
  }

  // პროდუქტის შემოწმება: მხოლოდ 7-Day Pass ანიჭებს წვდომას.
  const productId =
    (checkout.product && typeof checkout.product === "object"
      ? checkout.product.id
      : checkout.product) ||
    order?.product ||
    null;

  if (CREEM_PRODUCT_ID && productId && productId !== CREEM_PRODUCT_ID) {
    console.warn(
      `Creem webhook: product ${productId} is not the 7-Day Pass (${CREEM_PRODUCT_ID}), ignoring`,
    );
    return;
  }

  const email =
    (checkout.customer && typeof checkout.customer === "object"
      ? checkout.customer.email
      : null) || null;

  if (!email) {
    // ეს არ უნდა მოხდეს — Creem checkout ყოველთვის ითხოვს email-ს.
    // 500-ს ვაბრუნებთ, რომ Creem-მა retry სცადოს და ლოგშიც დარჩეს.
    throw new Error(`no customer email on checkout ${checkoutId} (order ${orderId})`);
  }

  await grantTripPassFromWebhook(email, `creem_${paymentId}`, "creem");

  console.log(
    `Creem webhook: checkout.completed processed for ${email.toLowerCase()} ` +
      `(order ${orderId}, checkout ${checkoutId})`,
  );
}

// ------------------------------------------------------------
// refund.created — ამჟამად მხოლოდ ლოგი. Refund-ებს ხელით
// გასცემ Creem dashboard-იდან, და წვდომის გაუქმებაც ხელით
// (Firestore: users/{uid}.tripPassExpiresAt) საჭიროების მიხედვით.
// ------------------------------------------------------------
function logRefund(refund) {
  const email = refund?.customer?.email || "unknown";
  const orderId = refund?.order?.id || refund?.transaction?.order || "unknown";
  console.warn(
    `Creem webhook: REFUND created for ${email} (order ${orderId}, ` +
      `amount ${refund?.refund_amount} ${refund?.refund_currency}). ` +
      `Access is NOT revoked automatically.`,
  );
}

// ------------------------------------------------------------
// HTTP handler (server.js-იდან)
// ------------------------------------------------------------
function handleCreemWebhook(req, res) {
  // Buffer.concat — multi-byte UTF-8 სიმბოლოები chunk-ის საზღვარზე
  // არ დაზიანდება, ამიტომ HMAC სწორად დაითვლება.
  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    if (aborted) return;

    received += chunk.length;

    if (received > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }

    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;

    const rawBody = Buffer.concat(chunks);
    const signatureHeader = req.headers["creem-signature"];

    if (!verifyCreemSignature(rawBody, signatureHeader)) {
      console.warn("Creem webhook: invalid or missing creem-signature header");
      res.writeHead(401);
      res.end();
      return;
    }

    let event;

    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      console.error("Creem webhook: invalid JSON:", error.message);
      res.writeHead(400);
      res.end();
      return;
    }

    const eventType = event?.eventType;

    try {
      switch (eventType) {
        case "checkout.completed":
          await processCheckoutCompleted(event.object);
          break;

        case "refund.created":
          logRefund(event.object);
          break;

        case "dispute.created":
          console.warn(
            `Creem webhook: DISPUTE created (${event.object?.id}) for ` +
              `${event.object?.customer?.email || "unknown"}`,
          );
          break;

        default:
          // სხვა event-ები (subscription.* და ა.შ.) ჩვენთვის არარელევანტურია.
          console.log(`Creem webhook: ignoring event ${eventType}`);
          break;
      }

      res.writeHead(200);
      res.end("OK");
    } catch (error) {
      console.error(
        `Creem webhook: processing ${eventType} (${event?.id}) failed:`,
        error.message,
      );
      res.writeHead(500);
      res.end();
    }
  });

  req.on("error", (error) => {
    console.error("Creem webhook: request stream error:", error.message);
  });
}

module.exports = { handleCreemWebhook, verifyCreemSignature };
