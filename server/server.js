require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const admin = require("firebase-admin");

const { toolDeclarations, executeTool } = require("./tools");
const {
  db,
  verifyClientToken,
  checkDailyQuota,
  addUsage,
  claimPendingPass,
  notifyLimitReachedForUid,
} = require("./auth");
const { handlePaddleWebhook } = require("./paddleWebhook");
const { sendWelcomeEmail } = require("./welcomeEmail");

// ============================================================
// Landmarks skeleton
// ============================================================

function buildLandmarksSkeletonText(landmarks) {
  if (!landmarks || landmarks.length === 0) {
    return "";
  }

  const lines = landmarks.map((l) => `- ${l.title} (${l.type})`).join("\n");

  return (
    "საქართველოს ღირსშესანიშნაობების სია (თბილისი და სხვა რეგიონები) — " +
    "თუ მომხმარებელი ეკითხება ან საუბარში ახსენებს რომელიმეს ამ სიიდან (მათ შორის " +
    "ალტერნატიული სახელით ან ტრანსლიტერაციით), სავალდებულოა ჯერ გამოიძახო " +
    "getLandmarkDetails მისი ზუსტი სახელით — ჯერ ეს, და მხოლოდ found:false-ის " +
    "შემთხვევაში გადადი Google Search-ზე ან საკუთარ ცოდნაზე:\n" +
    `${lines}`
  );
}

// ============================================================
// Configuration
// ============================================================

const PORT = Number(process.env.PORT || 8080);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest";

// Max consecutive Gemini reconnect attempts before giving up on a session.
// Resets to 0 on every successful Gemini connection (see geminiSocket "open").
const MAX_GEMINI_RECONNECT_ATTEMPTS = 5;

// ============================================================
// Gemini Live endpoint
// ============================================================

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set — check your .env");

  process.exit(1);
}

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta." +
  "GenerativeService.BidiGenerateContent" +
  `?key=${GEMINI_API_KEY}`;

// ============================================================
// HTTP server
// ============================================================

const server = http.createServer((req, res) => {
  // wss (WebSocket.Server) მხოლოდ "upgrade" event-ს უსმენს
  // (path: "/live"-ისთვის) — ჩვეულებრივი HTTP POST request-ები
  // (როგორიც webhook-ია) აქ, ამ request handler-ში ხვდება,
  // საერთოდ არ ეჯახება WebSocket ლოგიკას.
  if (req.method === "POST" && req.url === "/paddle-webhook") {
    handlePaddleWebhook(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/claim-pass") {
    handleClaimPass(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/register-user") {
    handleRegisterUser(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/notify-limit-reached") {
    handleNotifyLimitReached(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({
  server,
  path: "/live",
});

// ============================================================
// Client connection
// ============================================================

wss.on("connection", (clientSocket) => {
  console.log("Client connected");

  const session = {
    authed: false,
    uid: null,
    usageStartAt: null,
    quotaTimer: null,
    quotaTier: null,
    geminiSocket: null,
    currentLocation: null,
    landmarks: null,
    nearbyPlacesCache: [],
    lastSearchResults: null,
    resumptionToken: null,
    reconnecting: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    landmarksInjected: false,
    preferredLanguage: null,
    connectionGeneration: 0,
    lastAudioReceivedAt: null,
    firstResponseAt: null,
  };

  clientSocket.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid client JSON:", error.message);
      sendError(clientSocket, "Malformed JSON");
      return;
    }

    if (msg.type === "auth") {
      let uid;
      let isAnonymous; // ⬅️ ახალი

      try {
        const verified = await verifyClientToken(msg.idToken);
        uid = verified.uid;
        isAnonymous = verified.isAnonymous; // ⬅️ ახალი
      } catch (error) {
        console.error("Auth failed:", error.message);
        sendError(clientSocket, "Authentication failed");
        clientSocket.close(4003, "Authentication failed");
        return;
      }

      let quota;

      try {
        quota = await checkDailyQuota(uid, isAnonymous, msg.preferredLanguage); // ⬅️ isAnonymous + locale დაემატა
      } catch (error) {
        console.error("Quota check failed:", error.message);
        sendError(clientSocket, "Quota check failed");
        clientSocket.close(1011, "Quota check failed");
        return;
      }

      if (!quota.allowed) {
        console.log(`Daily quota exhausted for uid ${uid}`);
        sendToClient(clientSocket, {
          type: "quota_exceeded",
          remainingSeconds: 0,
          quotaTier: quota.quotaTier,
        });
        clientSocket.close(4029, "Daily quota exceeded");
        return;
      }

      session.authed = true;
      session.uid = uid;
      session.usageStartAt = Date.now();
      session.preferredLanguage =
        typeof msg.preferredLanguage === "string"
          ? msg.preferredLanguage
          : null;

      console.log(
        `Client authenticated: ${uid}, remaining today: ${Math.round(
          quota.remainingSeconds / 60,
        )} min` +
          (session.preferredLanguage
            ? ` (${session.preferredLanguage})`
            : " (no preferredLanguage)"),
      );

      sendToClient(clientSocket, {
        type: "auth_ok",
        remainingSeconds: quota.remainingSeconds,
      });

      session.quotaTier = quota.quotaTier;

      session.quotaTimer = setTimeout(() => {
        console.log(`Quota timer fired for uid ${uid} — closing session`);
        sendToClient(clientSocket, {
          type: "quota_exceeded",
          remainingSeconds: 0,
          quotaTier: session.quotaTier,
        });
        try {
          clientSocket.close(4029, "Daily quota exceeded");
        } catch (error) {
          console.error("Error closing client socket on quota:", error.message);
        }
      }, quota.remainingSeconds * 1000);

      connectToGeminiLive(clientSocket, session);
      return;
    }

    if (!session.authed) {
      sendError(clientSocket, "Not authenticated");
      return;
    }

    if (msg.type === "ping") {
      sendToClient(clientSocket, { type: "pong" });
      return;
    }

    if (msg.type === "context") {
      if (msg.currentLocation) {
        session.currentLocation = msg.currentLocation;
      }
      if (msg.landmarks && msg.landmarks.length > 0) {
        session.landmarks = msg.landmarks;
      }
      if (
        !session.geminiSocket ||
        session.geminiSocket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      sendContextToGemini(session, msg);
      return;
    }

    if (
      !session.geminiSocket ||
      session.geminiSocket.readyState !== WebSocket.OPEN
    ) {
      if (session.reconnecting) {
        return;
      }
      sendError(clientSocket, "Gemini session not ready yet");
      return;
    }

    if (msg.type === "audio") {
      if (!msg.data) {
        sendError(clientSocket, "Audio data is missing");
        return;
      }
      session.lastAudioReceivedAt = Date.now();
      try {
        session.geminiSocket.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: msg.data,
                mimeType: "audio/pcm;rate=16000",
              },
            },
          }),
        );
      } catch (error) {
        console.error("Failed to send audio to Gemini:", error.message);
      }
      return;
    }

    if (msg.type === "interrupt") {
      console.log("Client requested interruption");
      return;
    }

    sendError(clientSocket, `Unknown message type: ${msg.type}`);
  });

  clientSocket.on("close", () => {
    console.log("Client disconnected");

    if (session.quotaTimer) {
      clearTimeout(session.quotaTimer);
      session.quotaTimer = null;
    }

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    if (session.uid && session.usageStartAt) {
      const usedSeconds = (Date.now() - session.usageStartAt) / 1000;
      session.usageStartAt = null;
      addUsage(session.uid, usedSeconds, session.quotaTier).catch((error) => {
        console.error("Failed to record usage:", error.message);
      });
    }

    session.reconnecting = false;
    session.connectionGeneration += 1;

    const geminiSocket = session.geminiSocket;
    session.geminiSocket = null;

    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) {
      try {
        geminiSocket.close(1000, "Client disconnected");
      } catch (error) {
        console.error("Error closing Gemini socket:", error.message);
      }
    }
  });

  clientSocket.on("error", (error) => {
    console.error("Client WebSocket error:", error.message);
  });
});

// ============================================================
// POST /claim-pass
//
// Client-ი ამას იძახებს sign-in-ის დაუყოვნებლივ შემდეგ, ახალი
// ID token-ით — თუ ამ email-ზე Paddle webhook-ს უკვე დაუწერია
// pendingPasses დოკუმენტი (იხ. auth.js/paddleWebhook.js), ის
// "მიეჩემება" ამჟამინდელ uid-ს.
// ============================================================

function handleClaimPass(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;

    if (body.length > 100_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    let payload;

    try {
      payload = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    let uid;

    try {
      const verified = await verifyClientToken(payload.idToken);
      uid = verified.uid;
    } catch (error) {
      console.error("claim-pass auth failed:", error.message);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    try {
      const userRecord = await admin.auth().getUser(uid);
      const email = userRecord.email;

      if (!email) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ claimed: false }));
        return;
      }

      const result = await claimPendingPass(uid, email);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          result.claimed
            ? {
                claimed: true,
                expiresAt: result.expiresAt.toDate().toISOString(),
              }
            : { claimed: false },
        ),
      );
    } catch (error) {
      console.error("claim-pass failed:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  });
}

// ============================================================
// POST /register-user
//
// Client-ი ამას იძახებს პირველი წარმატებული sign-in-ის შემდეგ,
// device locale-ით — თუ ჯერ არ გაუგზავნია welcome email
// (users/{uid}.welcomeEmailSent !== true), აგზავნის მას და
// წერს დროშას, რომ მეორედ აღარ გაიგზავნოს.
// ============================================================

function handleRegisterUser(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;

    if (body.length > 100_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    let payload;

    try {
      payload = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    let decodedToken;

    try {
      decodedToken = await admin.auth().verifyIdToken(payload.idToken);
    } catch (error) {
      console.error("register-user auth failed:", error.message);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    try {
      const uid = decodedToken.uid;
      const userRef = db.collection("users").doc(uid);
      const userDoc = await userRef.get();
      const alreadySent =
        userDoc.exists && userDoc.data().welcomeEmailSent === true;

      let sent = false;

      if (!alreadySent && decodedToken.email) {
        const result = await sendWelcomeEmail(
          decodedToken.email,
          payload.locale,
        );

        if (result.success) {
          await userRef.set({ welcomeEmailSent: true }, { merge: true });
          sent = true;
        } else {
          console.error("register-user: welcome email failed:", result.error);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sent }));
    } catch (error) {
      console.error("register-user failed:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  });
}

// ============================================================
// POST /notify-limit-reached
//
// Client-ი ამას იძახებს text-chat-ის დღიური ლიმიტის ამოწურვისას
// (type: "text"). ხმოვანი (Live) ლიმიტისთვის იგივე throttle +
// გაგზავნის ლოგიკა (notifyLimitReachedForUid, auth.js) პირდაპირ
// server-ის მხრიდან იძახება, client-ის მოთხოვნის გარეშე — იხ.
// checkDailyQuota.
// ============================================================

function handleNotifyLimitReached(req, res) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;

    if (body.length > 100_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    let payload;

    try {
      payload = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    let decodedToken;

    try {
      decodedToken = await admin.auth().verifyIdToken(payload.idToken);
    } catch (error) {
      console.error("notify-limit-reached auth failed:", error.message);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    try {
      const type = payload.type === "voice" ? "voice" : "text";
      const result = await notifyLimitReachedForUid(
        decodedToken.uid,
        payload.locale,
        type,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("notify-limit-reached failed:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  });
}

// ============================================================
// Send stored context to Gemini
// ============================================================

function sendContextToGemini(session, msg) {
  if (
    !session.geminiSocket ||
    session.geminiSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (msg.landmarks && msg.landmarks.length > 0) {
    session.landmarks = msg.landmarks;

    const skeletonText = buildLandmarksSkeletonText(msg.landmarks);
    const fullContext = `[SYSTEM CONTEXT — not spoken by user]\n${skeletonText}`;

    try {
      session.geminiSocket.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [{ text: fullContext }],
              },
            ],
            turnComplete: false,
          },
        }),
      );
      session.landmarksInjected = true;
      console.log("Landmarks skeleton sent:", msg.landmarks.length, "items");
    } catch (error) {
      console.error("Failed to send landmark context:", error.message);
    }
  }

  if (msg.nearbyLandmarks && msg.nearbyLandmarks.length > 0) {
    const nearbyText =
      `[SYSTEM CONTEXT — not spoken by user]\n` +
      `მომხმარებელი ახლა ახლოს არის შემდეგ ღირსშესანიშნაობებთან, ` +
      `მანძილის მიხედვით დალაგებული: ` +
      `${msg.nearbyLandmarks.join(", ")}. ` +
      `თუ საუბარში შესაბამისია, გაითვალისწინე რეკომენდაციებში.`;

    try {
      session.geminiSocket.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [{ text: nearbyText }],
              },
            ],
            turnComplete: false,
          },
        }),
      );
      console.log("Nearby landmarks updated:", msg.nearbyLandmarks.join(", "));
    } catch (error) {
      console.error("Failed to send nearby landmarks:", error.message);
    }
  }

  if (msg.text) {
    try {
      session.geminiSocket.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: "[SYSTEM CONTEXT — not spoken by user] " + msg.text,
                  },
                ],
              },
            ],
            turnComplete: false,
          },
        }),
      );
    } catch (error) {
      console.error("Failed to send additional context:", error.message);
    }
  }
}

// ============================================================
// Connect to Gemini Live
// ============================================================

function connectToGeminiLive(clientSocket, session) {
  if (clientSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const generation = ++session.connectionGeneration;

  console.log(
    session.resumptionToken
      ? "Reconnecting to Gemini Live with resumption token..."
      : "Connecting to Gemini Live...",
  );

  const geminiSocket = new WebSocket(GEMINI_LIVE_URL);
  session.geminiSocket = geminiSocket;
  session.reconnecting = false;

  geminiSocket.on("open", () => {
    if (session.connectionGeneration !== generation) {
      try {
        geminiSocket.close();
      } catch {}
      return;
    }

    console.log("Connected to Gemini Live");

    // A successful connection clears the retry count — the next
    // unexpected close starts counting from zero again.
    session.reconnectAttempts = 0;

    const modelName = GEMINI_MODEL.startsWith("models/")
      ? GEMINI_MODEL
      : `models/${GEMINI_MODEL}`;

    console.log(`Starting Gemini model: ${modelName}`);

    // ========================================================
    // Language instruction
    // ========================================================

    const languageInstruction = session.preferredLanguage
      ? `The user's app interface language is "${session.preferredLanguage}". ` +
        "Respond in that language by default. " +
        "If the user clearly changes to another language and continues using it, " +
        "you may follow the user's language. "
      : "";

    // ========================================================
    // System instruction
    // ========================================================

    const systemInstructionText =
      languageInstruction +
      // ------------------------------------------------------
      // Persona + conversation style
      // ------------------------------------------------------
      "You are a concise Georgia travel guide in a real-time voice conversation. " +
      "You cover all of Georgia — its regions, cities, towns, villages, and landmarks. " +
      "When relevant, mention Tbilisi as the capital city of Georgia, but do not limit " +
      "yourself to Tbilisi alone. " +
      "Wait for the user to speak first; do not start speaking automatically. " +
      "Keep answers concise and suitable for real-time voice — avoid long monologues " +
      "unless the user explicitly asks for detailed information. " +
      // ------------------------------------------------------
      // Information sources: local catalog + Google Search
      // ------------------------------------------------------
      "You have two sources of factual information. First, a local landmark catalog " +
      "(names and types only) — call getLandmarkDetails for a listed landmark's full " +
      "history or description. Second, the built-in Google Search tool, for anything " +
      "the catalog doesn't cover: other real-world places, restaurants, cafes, hotels, " +
      "shops, attractions, museums, streets, neighborhoods, events, businesses, opening " +
      "hours, prices, reviews, or current information. " +
      "If the place the user is asking about matches, or plausibly matches (including " +
      "alternate names, spellings, or transliterations), an entry in the landmark " +
      "catalog list provided below, you must call getLandmarkDetails for it FIRST — " +
      "before using Google Search and before answering from your own general " +
      "knowledge — even for a famous, well-known landmark you're confident you already " +
      "know about. Do not skip straight to Google Search or your own knowledge for a " +
      "catalog landmark just because you recognize it. " +
      "The catalog is not guaranteed to be complete — never assume a place or fact " +
      "doesn't exist just because it's not in the catalog. If getLandmarkDetails, " +
      "openPlaceOnMap, or showRouteToPlace returns found:false, use Google Search " +
      "instead of giving up or saying you cannot find it. Never invent facts when " +
      "Google Search can supply them. If Google Search finds a place and the user then " +
      "wants it on the map or wants directions, call findNearbyPlaces first to resolve " +
      "it through Google Places and get its coordinates, then call openPlaceOnMap or " +
      "showRouteToPlace with that exact returned name. " +
      "Never mention internal tools, APIs, databases, or catalog limitations to the " +
      "user. " +
      // ------------------------------------------------------
      // Nearby places + open/closed handling
      // ------------------------------------------------------
      "Use findNearbyPlaces for nearby restaurants, hotels, nightlife, shopping, " +
      "stores, cafes, gas stations, pharmacies, parks, public transport, and ATMs, or " +
      "when the user asks what's interesting nearby (also consider the nearby landmark " +
      "context already provided). Each result includes isOpen: true (open now), false " +
      "(closed now), or null (unknown). Always mention whether a place is currently " +
      "open, especially if the user asked about visiting now. If the closest result is " +
      "closed, say so clearly and don't recommend it as open — if a fartherOpenAlternative " +
      "is included, offer that instead. If isOpen is null, say its status is unknown " +
      "rather than assuming it's open. " +
      // ------------------------------------------------------
      // Current location
      // ------------------------------------------------------
      "Use getCurrentLocationInfo when the user asks where they currently are or what " +
      "place/business/landmark they're standing at or near (e.g. 'სად ვარ მე?', " +
      "'what is this place'). Describe the result naturally: the kind of place, its " +
      "name if known, and general address/neighborhood — or just the address if " +
      "nearestPlace is null. Never guess the user's location without calling this tool " +
      "first. " +
      // ------------------------------------------------------
      // Exact names
      // ------------------------------------------------------
      "When calling getLandmarkDetails, openPlaceOnMap, or showRouteToPlace, always use " +
      "the exact place name returned by the catalog or findNearbyPlaces — never " +
      "translate or transliterate it. " +
      // ------------------------------------------------------
      // Locked landmark content
      // ------------------------------------------------------
      "If getLandmarkDetails returns locked: true, tell the user briefly that this " +
      "location's full details aren't available to them right now, without mentioning " +
      "any specific product, subscription, or price — do not invent or guess at the " +
      "location's history. " +
      "If getLandmarkDetails returns locked: true for a location, do not use Google " +
      "Search or any other source to answer about that same location instead — simply " +
      "give the neutral 'not available right now' response and do not provide any " +
      "further details, facts, or history about it, even if you already know them or " +
      "could look them up. This applies even though Google Search is otherwise " +
      "encouraged for places outside the catalog. " +
      // ------------------------------------------------------
      // Map actions
      // ------------------------------------------------------
      "Map actions: call openPlaceOnMap to show a specific place; call showRouteToPlace " +
      "only when the user clearly asks for directions or a route (never speculatively); " +
      "call openMap when the user asks to open/show the map with no specific place " +
      "(e.g. 'გახსენი რუკა'); call showMyLocationOnMap when the user wants to see their " +
      "own current position on the map (e.g. 'მაჩვენე ჩემი ლოკაცია') — this centers the " +
      "map on real GPS coordinates, unlike getCurrentLocationInfo which only describes " +
      "the location in words. " +
      // ------------------------------------------------------
      // Georgian century rule
      // ------------------------------------------------------
      "When speaking Georgian and referring to a century, use the correct ordinal form " +
      "(e.g. 'მეცამეტე საუკუნე', not 'ცამეტი საუკუნე'). " +
      // ------------------------------------------------------
      // Safety filter
      // ------------------------------------------------------
      "If the user asks about visiting unsafe, abandoned, restricted, or otherwise " +
      "not-recommended areas (abandoned buildings, unsafe areas at night, border " +
      "zones), don't give directions to or encourage visiting them — gently " +
      "acknowledge their interest and suggest a safe, thematically similar alternative " +
      "instead. Never confirm an unfamiliar place is safe without reliable information. " +
      // ------------------------------------------------------
      // Landmarks skeleton (unchanged, appended dynamically)
      // ------------------------------------------------------
      (session.landmarks && session.landmarks.length > 0
        ? "\n\n" + buildLandmarksSkeletonText(session.landmarks)
        : "");

    const setupMessage = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ["AUDIO"],
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            prefixPaddingMs: 300,
            silenceDurationMs: 800,
          },
        },
        contextWindowCompression: {
          slidingWindow: {},
        },
        sessionResumption: session.resumptionToken
          ? { handle: session.resumptionToken }
          : {},
        systemInstruction: {
          parts: [{ text: systemInstructionText }],
        },
        tools: [{ googleSearch: {} }, ...toolDeclarations],
      },
    };

    try {
      geminiSocket.send(JSON.stringify(setupMessage));
      console.log(
        "Gemini setup sent with built-in Google Search + custom tools",
      );
    } catch (error) {
      console.error("Failed to send Gemini setup:", error.message);
    }
  });

  geminiSocket.on("message", async (raw) => {
    if (session.connectionGeneration !== generation) {
      return;
    }

    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid Gemini message:", error.message);
      return;
    }

    if (msg.setupComplete) {
      console.log("Gemini Live session ready");
      sendToClient(clientSocket, {
        type: "gemini_ready",
        needsLandmarks: !session.landmarks || session.landmarks.length === 0,
      });
      if (
        session.landmarks &&
        session.landmarks.length > 0 &&
        !session.landmarksInjected
      ) {
        sendContextToGemini(session, {
          landmarks: session.landmarks,
          currentLocation: session.currentLocation,
        });
      }
      return;
    }

    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) {
        session.resumptionToken = update.newHandle;
        console.log("Gemini session resumption token updated");
      }
      return;
    }

    if (msg.error) {
      console.error("Gemini API error:", JSON.stringify(msg.error));
      sendToClient(clientSocket, {
        type: "error",
        message: msg.error.message || "Gemini API error",
      });
      return;
    }

    if (msg.toolCall) {
      await handleGeminiToolCalls(
        clientSocket,
        geminiSocket,
        session,
        msg.toolCall,
      );
      return;
    }

    const serverContent = msg.serverContent;
    if (!serverContent) {
      return;
    }

    const parts = serverContent.modelTurn?.parts || [];

    if (parts.length > 0 && !session.firstResponseAt) {
      session.firstResponseAt = Date.now();
      const gapMs = session.lastAudioReceivedAt
        ? session.firstResponseAt - session.lastAudioReceivedAt
        : null;
      console.log(
        `[TIMING] First response chunk. Gap since last user audio: ${
          gapMs !== null ? gapMs + "ms" : "unknown"
        }`,
      );
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        sendToClient(clientSocket, {
          type: "audio",
          data: part.inlineData.data,
        });
      }
      if (part.text) {
        sendToClient(clientSocket, {
          type: "text",
          data: part.text,
        });
      }
    }

    if (serverContent.turnComplete) {
      if (session.firstResponseAt && session.lastAudioReceivedAt) {
        console.log(
          `[TIMING] Turn complete. Total latency: ${
            session.firstResponseAt - session.lastAudioReceivedAt
          }ms`,
        );
      }
      session.firstResponseAt = null;
      session.lastAudioReceivedAt = null;
      sendToClient(clientSocket, {
        type: "turnEnd",
        interrupted: false,
      });
    }

    if (serverContent.interrupted) {
      sendToClient(clientSocket, {
        type: "turnEnd",
        interrupted: true,
      });
    }
  });

  geminiSocket.on("error", (error) => {
    console.error("Gemini Live socket error:", error.message);
  });

  geminiSocket.on("close", (code, reason) => {
    const reasonText = reason ? reason.toString() : "";
    console.log(
      `[TIMING] Gemini socket closed at ${new Date().toISOString()}: ${code}, reason: ${
        reasonText || "No reason provided"
      }`,
    );

    if (session.connectionGeneration !== generation) {
      return;
    }

    if (session.geminiSocket === geminiSocket) {
      session.geminiSocket = null;
    }

    const intentionalClose =
      code === 1000 && reasonText === "Client disconnected";

    if (intentionalClose) {
      return;
    }

    if (clientSocket.readyState !== WebSocket.OPEN) {
      session.reconnecting = false;
      return;
    }

    // A reconnect timer is already pending (or an attempt is already in
    // flight) for this session — never schedule a second one.
    if (session.reconnecting || session.reconnectTimer) {
      return;
    }

    if (session.reconnectAttempts >= MAX_GEMINI_RECONNECT_ATTEMPTS) {
      console.error(
        `Gemini reconnect attempts exhausted (${session.reconnectAttempts}/` +
          `${MAX_GEMINI_RECONNECT_ATTEMPTS}) — ending session`,
      );
      sendToClient(clientSocket, {
        type: "sessionEnd",
        code,
        reason: "max_reconnect_attempts_exceeded",
      });
      try {
        clientSocket.close(1011, "Gemini reconnect attempts exhausted");
      } catch (error) {
        console.error(
          "Error closing client socket after exhausted retries:",
          error.message,
        );
      }
      return;
    }

    session.reconnecting = true;
    session.reconnectAttempts += 1;

    console.log(
      (session.resumptionToken
        ? "Scheduling Gemini reconnect with resumption token"
        : "Scheduling Gemini reconnect") +
        ` (attempt ${session.reconnectAttempts}/${MAX_GEMINI_RECONNECT_ATTEMPTS})...`,
    );

    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;

      if (clientSocket.readyState === WebSocket.OPEN) {
        connectToGeminiLive(clientSocket, session);
      } else {
        session.reconnecting = false;
      }
    }, 300);
  });
}

// ============================================================
// Gemini custom tool-call handler
// ============================================================

async function handleGeminiToolCalls(
  clientSocket,
  geminiSocket,
  session,
  toolCall,
) {
  const functionCalls = toolCall.functionCalls || [];

  if (functionCalls.length === 0) {
    return;
  }

  const functionResponses = [];

  for (const call of functionCalls) {
    console.log(`Gemini tool call: ${call.name}`, call.args || {});

    let result;

    try {
      result = await executeTool(call.name, call.args || {}, session);
    } catch (error) {
      console.error(`Tool "${call.name}" execution error:`, error.message);
      result = { error: "tool_execution_failed" };
    }

    if (call.name === "findNearbyPlaces" && result && !result.error) {
      console.log("Nearby places search completed");
    }

    if (call.name === "getCurrentLocationInfo" && result && !result.error) {
      console.log("Current location lookup completed");
    }

    if (
      (call.name === "openPlaceOnMap" ||
        call.name === "showRouteToPlace" ||
        call.name === "openMap" ||
        call.name === "showMyLocationOnMap") &&
      result &&
      result.found !== false
    ) {
      sendToClient(clientSocket, {
        type: "action",
        name: call.name,
        args: {
          placeId: result.title || call.args?.placeId,
          source: result.source,
          coordinates: result.coordinates,
          address: result.address,
          googlePlaceId: result.googlePlaceId,
          category: result.category,
        },
      });
    }

    functionResponses.push({
      id: call.id,
      name: call.name,
      response: result || { error: "empty_tool_response" },
    });
  }

  if (geminiSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    geminiSocket.send(
      JSON.stringify({
        toolResponse: {
          functionResponses,
        },
      }),
    );
    console.log(
      `Sent ${functionResponses.length} custom tool response(s) to Gemini`,
    );
  } catch (error) {
    console.error("Failed to send tool responses:", error.message);
  }
}

// ============================================================
// Send message safely to React Native
// ============================================================

function sendToClient(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error("Failed to send message to client:", error.message);
  }
}

// ============================================================
// Send error safely
// ============================================================

function sendError(socket, message) {
  sendToClient(socket, {
    type: "error",
    message,
  });
}

// ============================================================
// Start server
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini Live proxy listening on 0.0.0.0:${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log("Google Search: BUILT-IN GEMINI TOOL ENABLED");
  console.log("Custom tools: ENABLED");
  console.log("Firestore-backed daily quota: ENABLED");
});
