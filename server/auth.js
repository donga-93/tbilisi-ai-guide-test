const admin = require("firebase-admin");

const { sendLimitReachedEmail } = require("./welcomeEmail");

// ============================================================
// Credentials
//
// Production (Railway): FIREBASE_SERVICE_ACCOUNT_JSON env var
// holds the full service account JSON as a string.
//
// Local dev: falls back to ./serviceAccountKey.json on disk
// (gitignored — never committed).
// ============================================================

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let parsed;

    try {
      parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: " +
          error.message,
      );
    }

    console.log(
      "Firebase credentials: loaded from FIREBASE_SERVICE_ACCOUNT_JSON env var",
    );

    return admin.credential.cert(parsed);
  }

  console.log("Firebase credentials: loaded from local serviceAccountKey.json");

  return admin.credential.cert(require("./serviceAccountKey.json"));
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: loadCredential(),
  });
}

const db = admin.firestore();

// ============================================================
// Daily voice quota tiers
// ============================================================

const GUEST_DAILY_LIMIT_SECONDS = 3 * 60; // Guest (anonymous) — paywall-ის ტრიგერი
const DAILY_LIMIT_SECONDS = 20 * 60; // Signed-in, არა-subscriber
const FREE_LIFETIME_LIMIT_SECONDS = 60 * 60; // signed-in, non-premium — 60 min total, once, forever
const PREMIUM_DAILY_LIMIT_SECONDS = 60 * 60; // Subscribed
const TESTER_SESSION_CAP_SECONDS = Number(
  process.env.TESTER_SESSION_CAP_SECONDS || 90 * 60,
); // Tester — per-session safety-net, არა დღიური ჯამი

const TRIP_PASS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // Paddle 7-Day Trip Pass

const LIMIT_REACHED_EMAIL_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000; // მაქს. 1 email კვირაში

// ============================================================
// Token-ის ვერიფიკაცია
// ============================================================

async function verifyClientToken(idToken) {
  if (!idToken) {
    throw new Error("Missing auth token");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decodedToken.uid,
      isAnonymous: decodedToken.firebase?.sign_in_provider === "anonymous",
    };
  } catch (error) {
    throw new Error("Invalid token: " + error.message);
  }
}

// ============================================================
// მომხმარებლის დონის შემოწმება (subscribed/tester თუ არა)
// ============================================================

async function getAccessLevel(uid) {
  const userDoc = await db.collection("users").doc(uid).get();

  if (!userDoc.exists) {
    return { isSubscribed: false, isTester: false, hasActiveTripPass: false };
  }

  const data = userDoc.data();
  const hasActiveTripPass =
    !!data.tripPassExpiresAt && data.tripPassExpiresAt.toMillis() > Date.now();

  return {
    isSubscribed: data.isSubscribed === true,
    isTester: data.isTester === true,
    hasActiveTripPass, // ⬅️ ახალი: Paddle-ით ნაყიდი 7-დღიანი Trip Pass, ჯერ კიდევ აქტიური
  };
}

// ============================================================
// დღიური quota-ს შემოწმება — სამი tier: guest / free / premium,
// პლუს tester-ის სრული bypass (per-session safety-net-ით)
//
// აბრუნებს { allowed, remainingSeconds, dailyLimitSeconds, isTesterBypass }
// ============================================================

async function checkDailyQuota(uid, isAnonymous, locale) {
  const { isSubscribed, isTester, hasActiveTripPass } =
    await getAccessLevel(uid);

  if (isTester) {
    return {
      allowed: true,
      remainingSeconds: TESTER_SESSION_CAP_SECONDS,
      dailyLimitSeconds: null,
      isTesterBypass: true,
      quotaTier: "tester",
    };
  }

  const isPremium = isSubscribed || hasActiveTripPass;

  if (!isPremium && !isAnonymous) {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    const usedSeconds = userDoc.exists
      ? userDoc.data().voiceSecondsLifetimeUsed || 0
      : 0;

    const remainingSeconds = Math.max(
      0,
      FREE_LIFETIME_LIMIT_SECONDS - usedSeconds,
    );
    const allowed = remainingSeconds > 0;

    if (!allowed) {
      notifyLimitReachedForUid(uid, locale, "voice").catch((error) => {
        console.error("Voice limit-reached email failed:", error.message);
      });
    }

    return {
      allowed,
      remainingSeconds,
      dailyLimitSeconds: FREE_LIFETIME_LIMIT_SECONDS,
      isTesterBypass: false,
      quotaTier: "free_lifetime",
    };
  }

  // ⬅️ ახალი: აქტიური Trip Pass იმავე ლიმიტს იძლევა, რაც subscription,
  // isSubscribed-ის შეცვლის გარეშე.
  const dailyLimitSeconds = isPremium
    ? PREMIUM_DAILY_LIMIT_SECONDS
    : GUEST_DAILY_LIMIT_SECONDS;

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  const docRef = db.collection("usage").doc(`${uid}_${today}`);
  const doc = await docRef.get();

  const usedSeconds = doc.exists ? doc.data().secondsUsed || 0 : 0;
  const remainingSeconds = Math.max(0, dailyLimitSeconds - usedSeconds);
  const allowed = remainingSeconds > 0;

  if (!allowed) {
    // ⬅️ ახალი: ხმოვანი (Live) დღიური ლიმიტის ამოწურვისას, server-side,
    // ცალკე client-ის მოთხოვნის გარეშე — fire-and-forget, quota-ს
    // პასუხს არასდროს აყოვნებს და არასდროს ისვრის.
    notifyLimitReachedForUid(uid, locale, "voice").catch((error) => {
      console.error("Voice limit-reached email failed:", error.message);
    });
  }

  return {
    allowed,
    remainingSeconds,
    dailyLimitSeconds,
    isTesterBypass: false,
    quotaTier: isPremium ? "premium" : "guest",
  };
}

// ============================================================
// Limit-reached email — throttle (7 დღეში ერთხელ) + გაგზავნა.
//
// გამოიძახება ორი გზით:
//   - აქედან ზემოთ, checkDailyQuota-ს მიერ, ხმოვანი quota-ს
//     ამოწურვისას (type: "voice"), client-ის მოთხოვნის გარეშე
//   - server.js-ის POST /notify-limit-reached-იდან (type: "text"),
//     text-chat-ის დღიური ლიმიტისთვის, client-ის მოთხოვნით
// ============================================================
async function notifyLimitReachedForUid(uid, locale, type) {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const lastSentAt = userDoc.exists
    ? userDoc.data().limitReachedEmailSentAt
    : null;

  if (
    lastSentAt &&
    Date.now() - lastSentAt.toMillis() < LIMIT_REACHED_EMAIL_THROTTLE_MS
  ) {
    return { sent: false, reason: "throttled" };
  }

  const userRecord = await admin.auth().getUser(uid);
  const email = userRecord.email;

  if (!email) {
    return { sent: false, reason: "no_email" };
  }

  const result = await sendLimitReachedEmail(email, locale);

  if (!result.success) {
    console.error(
      `Limit-reached email failed for uid ${uid} (${type}):`,
      result.error,
    );
    return { sent: false, reason: "send_failed" };
  }

  await userRef.set(
    { limitReachedEmailSentAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );

  return { sent: true };
}

// ============================================================
// გამოყენებული წამების დამატება (სესიის დასრულებისას)
// ============================================================

async function addUsage(uid, seconds, quotaTier) {
  if (!seconds || seconds <= 0) return;

  if (quotaTier === "free_lifetime") {
    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          voiceSecondsLifetimeUsed: admin.firestore.FieldValue.increment(
            Math.round(seconds),
          ),
        },
        { merge: true },
      );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const docRef = db.collection("usage").doc(`${uid}_${today}`);

  await docRef.set(
    {
      uid,
      date: today,
      secondsUsed: admin.firestore.FieldValue.increment(Math.round(seconds)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ============================================================
// Subscription status write (webhook-ისთვის)
//
// ეს არის ერთადერთი ადგილი, სადაც isSubscribed ველი Firestore-ში
// იწერება — RevenueCat-ის webhook-ის ერთადერთი მომხმარებელია.
// Admin SDK Firestore rules-ს არ ექვემდებარება (allow write: if false
// მხოლოდ client SDK-ს ზღუდავს).
// ============================================================

async function setSubscriptionStatus(uid, { isSubscribed, expiresAtMs }) {
  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        isSubscribed,
        subscriptionExpiresAt:
          typeof expiresAtMs === "number"
            ? admin.firestore.Timestamp.fromMillis(expiresAtMs)
            : null,
        subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ============================================================
// Paddle → Firestore access-grant (webhook-ისთვის)
//
// Paddle checkout-ს არ სჭირდება Firebase login — მომხმარებელს
// შეუძლია იყიდოს Trip Pass ანგარიშზე შესვლამდეც. ამიტომ webhook-ი
// ჯერ ინახავს "pending" grant-ს email-ზე (Firestore-ში uid ჯერ არ
// ვიცით), მოგვიანებით კი sign-in-ის დროს claimPendingPass მას
// მიაბამს რეალურ uid-ს (users/{uid}.tripPassExpiresAt).
// ============================================================

async function grantTripPassFromWebhook(email, transactionId) {
  const docId = email.toLowerCase();
  const docRef = db.collection("pendingPasses").doc(docId);
  const doc = await docRef.get();

  if (doc.exists && doc.data().transactionId === transactionId) {
    // Paddle-მა იგივე webhook-ი retry-ით გამოგზავნა — უკვე დაწერილია.
    console.log(
      `Paddle: transaction ${transactionId} already granted for ${docId}, skipping`,
    );
    return;
  }

  const passExpiresAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + TRIP_PASS_DURATION_MS,
  );

  await docRef.set({
    passExpiresAt,
    transactionId,
    claimed: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(
    `Paddle: pending Trip Pass granted for ${docId} (transaction ${transactionId})`,
  );
}

// ============================================================
// Pending pass-ის "მიჩემება" — გამოიძახება sign-in-ის შემდეგ
// (client → POST /claim-pass), როცა უკვე ვიცით რეალური uid
// ============================================================

async function claimPendingPass(uid, email) {
  const docId = email.toLowerCase();
  const docRef = db.collection("pendingPasses").doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return { claimed: false };
  }

  const data = doc.data();

  if (data.claimed === true) {
    return { claimed: false };
  }

  const expiresAt = data.passExpiresAt;

  if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
    return { claimed: false };
  }

  await db
    .collection("users")
    .doc(uid)
    .set({ tripPassExpiresAt: expiresAt }, { merge: true });

  await docRef.set({ claimed: true }, { merge: true });

  return { claimed: true, expiresAt };
}

module.exports = {
  db, // ⬅️ ახალი
  verifyClientToken,
  checkDailyQuota,
  addUsage,
  setSubscriptionStatus, // ⬅️ ახალი
  grantTripPassFromWebhook, // ⬅️ ახალი
  claimPendingPass, // ⬅️ ახალი
  notifyLimitReachedForUid, // ⬅️ ახალი
  GUEST_DAILY_LIMIT_SECONDS,
  DAILY_LIMIT_SECONDS,
  FREE_LIFETIME_LIMIT_SECONDS,
  PREMIUM_DAILY_LIMIT_SECONDS,
};
