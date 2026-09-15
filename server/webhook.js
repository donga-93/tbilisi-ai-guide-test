const { setSubscriptionStatus } = require("./auth");

// ============================================================
// RevenueCat webhook handler
//
// RevenueCat POST-ავს ამ endpoint-ზე ყოველ entitlement-ცვლილებაზე
// (ახალი გამოწერა, განახლება, გაუქმება, ვადის გასვლა, billing
// პრობლემა და ა.შ.). ჩვენ ვწერთ მხოლოდ Firestore-ის
// users/{uid}.isSubscribed ველს — ეს ერთადერთი source of truth
// არის სერვერული quota-შემოწმებისთვის (auth.js/firestore.rules).
// ============================================================

const ENTITLEMENT_ID = "premium";

const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;

// ------------------------------------------------------------
// აქტიურობის განსაზღვრა
//
// expiration_at_ms-ზე დაფუძნებული ლოგიკა ვირჩევთ event.type-ების
// ამომწურავი ჩამონათვალის ნაცვლად — მომავალში ახალი event
// type-ების დამატებაც კი სწორად დამუშავდება ამ ლოგიკით.
//
// გაურკვევლობისას ვაბრუნებთ false (არა true) — billing-ის
// კონტექსტში ცრუ-უარყოფითი გაცილებით უსაფრთხოა, ვიდრე
// ცრუ-დადებითი.
// ------------------------------------------------------------
function resolveIsActive(event) {
  if (event.type === "EXPIRATION") {
    return false;
  }

  if (typeof event.expiration_at_ms === "number") {
    return event.expiration_at_ms > Date.now();
  }

  return false;
}

async function processRevenueCatEvent(event) {
  if (!event || typeof event !== "object") {
    console.warn("RevenueCat webhook: missing event object, ignoring");
    return;
  }

  const uid = event.app_user_id;

  if (!uid) {
    console.warn("RevenueCat webhook: event has no app_user_id, ignoring");
    return;
  }

  const entitlementIds = event.entitlement_ids || [];

  if (!entitlementIds.includes(ENTITLEMENT_ID)) {
    // ეს event სხვა entitlement-ს ეხება (ან საერთოდ არცერთს) —
    // ჩვენთვის არარელევანტურია, უბრალოდ ვტოვებთ.
    console.log(
      `RevenueCat webhook: event ${event.type} for uid ${uid} has no "${ENTITLEMENT_ID}" entitlement, skipping`,
    );
    return;
  }

  const isActive = resolveIsActive(event);

  await setSubscriptionStatus(uid, {
    isSubscribed: isActive,
    expiresAtMs: event.expiration_at_ms || null,
  });

  console.log(
    `RevenueCat webhook: uid ${uid} — ${event.type} → isSubscribed=${isActive}`,
  );
}

// ------------------------------------------------------------
// HTTP request handler (server.js-იდან გამოძახებული)
// ------------------------------------------------------------

function handleRevenueCatWebhook(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;

    // Basic DoS-guard — RevenueCat payload-ები მცირეა (KB-ების
    // ფარგლებში), 1MB-ზე მეტი ნიშნავს რაღაც არასწორია.
    if (body.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    const authHeader = req.headers["authorization"];

    if (
      !REVENUECAT_WEBHOOK_SECRET ||
      authHeader !== REVENUECAT_WEBHOOK_SECRET
    ) {
      console.warn(
        "RevenueCat webhook: invalid or missing Authorization header",
      );
      res.writeHead(401);
      res.end();
      return;
    }

    let payload;

    try {
      payload = JSON.parse(body);
    } catch (error) {
      console.error("RevenueCat webhook: invalid JSON:", error.message);
      res.writeHead(400);
      res.end();
      return;
    }

    try {
      await processRevenueCatEvent(payload.event);

      res.writeHead(200);
      res.end("OK");
    } catch (error) {
      console.error("RevenueCat webhook processing failed:", error.message);

      // 500-ის დაბრუნება იმისთვის, რომ RevenueCat-მა ავტომატურად
      // სცადოს retry (RevenueCat retries on non-2xx responses).
      res.writeHead(500);
      res.end();
    }
  });
}

module.exports = { handleRevenueCatWebhook };
