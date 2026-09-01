const admin = require("firebase-admin");

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

const DAILY_LIMIT_SECONDS = 20 * 60; // 20 წუთი დღეში

// ============================================================
// Token-ის ვერიფიკაცია
// ============================================================

async function verifyClientToken(idToken) {
  if (!idToken) {
    throw new Error("Missing auth token");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return { uid: decodedToken.uid };
  } catch (error) {
    throw new Error("Invalid token: " + error.message);
  }
}

// ============================================================
// დღიური quota-ს შემოწმება (სესიის დაწყებამდე)
//
// აბრუნებს { allowed: boolean, remainingSeconds: number }
// ============================================================

async function checkDailyQuota(uid) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  const docRef = db.collection("usage").doc(`${uid}_${today}`);
  const doc = await docRef.get();

  const usedSeconds = doc.exists ? doc.data().secondsUsed || 0 : 0;
  const remainingSeconds = Math.max(0, DAILY_LIMIT_SECONDS - usedSeconds);

  return {
    allowed: remainingSeconds > 0,
    remainingSeconds,
  };
}

// ============================================================
// გამოყენებული წამების დამატება (სესიის დასრულებისას)
// ============================================================

async function addUsage(uid, seconds) {
  if (!seconds || seconds <= 0) return;

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

module.exports = {
  verifyClientToken,
  checkDailyQuota,
  addUsage,
  DAILY_LIMIT_SECONDS,
};
