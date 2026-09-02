require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");

const { toolDeclarations, executeTool } = require("./tools");
const { verifyClientToken, checkDailyQuota, addUsage } = require("./auth");

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
    "თუ საუბარში რომელიმეს ახსენებენ, გამოიყენე მხოლოდ საორიენტაციოდ. " +
    "დეტალური ინფორმაციისთვის " +
    `გამოიძახე getLandmarkDetails:\n${lines}`
  );
}

// ============================================================
// Configuration
// ============================================================

const PORT = Number(process.env.PORT || 8080);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest";

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

const server = http.createServer();

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
    geminiSocket: null,
    currentLocation: null,
    landmarks: null,
    nearbyPlacesCache: [],
    lastSearchResults: null,
    resumptionToken: null,
    reconnecting: false,
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

      try {
        const verified = await verifyClientToken(msg.idToken);
        uid = verified.uid;
      } catch (error) {
        console.error("Auth failed:", error.message);
        sendError(clientSocket, "Authentication failed");
        clientSocket.close(4003, "Authentication failed");
        return;
      }

      let quota;

      try {
        quota = await checkDailyQuota(uid);
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

      session.quotaTimer = setTimeout(() => {
        console.log(`Quota timer fired for uid ${uid} — closing session`);
        sendToClient(clientSocket, {
          type: "quota_exceeded",
          remainingSeconds: 0,
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

    if (session.uid && session.usageStartAt) {
      const usedSeconds = (Date.now() - session.usageStartAt) / 1000;
      session.usageStartAt = null;
      addUsage(session.uid, usedSeconds).catch((error) => {
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

    if (!session.reconnecting && clientSocket.readyState === WebSocket.OPEN) {
      session.reconnecting = true;
      console.log(
        session.resumptionToken
          ? "Scheduling Gemini reconnect with resumption token..."
          : "Scheduling Gemini reconnect...",
      );
      setTimeout(() => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          connectToGeminiLive(clientSocket, session);
        } else {
          session.reconnecting = false;
        }
      }, 300);
      return;
    }

    sendToClient(clientSocket, {
      type: "sessionEnd",
      code,
      reason: reasonText,
    });
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
