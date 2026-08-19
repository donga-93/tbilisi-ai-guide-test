require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");

const { toolDeclarations, executeTool } = require("./tools");

// ============================================================
// Landmarks skeleton
//
// Only name + type are sent into Gemini's live context.
// Full descriptions stay in session.landmarks and are retrieved
// through getLandmarkDetails when needed.
// ============================================================

function buildLandmarksSkeletonText(landmarks) {
  if (!landmarks || landmarks.length === 0) {
    return "";
  }

  const lines = landmarks.map((l) => `- ${l.title} (${l.type})`).join("\n");

  return (
    "თბილისის ღირსშესანიშნაობების სია — თუ საუბარში რომელიმეს ახსენებენ, " +
    "გამოიყენე მხოლოდ საორიენტაციოდ. დეტალური ინფორმაციისთვის " +
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

  // ==========================================================
  // Per-client session
  // ==========================================================

  const session = {
    authed: false,

    uid: "solo-test-user",

    geminiSocket: null,

    currentLocation: null,

    landmarks: null,

    nearbyPlacesCache: [],

    // Last Google Search result is kept only for this session.
    lastSearchResults: null,

    // Gemini Live session resumption
    resumptionToken: null,

    reconnecting: false,

    // Prevent duplicate landmark context injection
    landmarksInjected: false,

    preferredLanguage: null,

    // Prevent processing stale Gemini sockets
    connectionGeneration: 0,
    // Timing diagnostics
    lastAudioReceivedAt: null,
    firstResponseAt: null,
  };

  // ==========================================================
  // Messages from React Native
  // ==========================================================

  clientSocket.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid client JSON:", error.message);

      sendError(clientSocket, "Malformed JSON");

      return;
    }

    // ========================================================
    // Authentication
    // ========================================================

    if (msg.type === "auth") {
      session.authed = true;

      session.preferredLanguage =
        typeof msg.preferredLanguage === "string"
          ? msg.preferredLanguage
          : null;

      console.log(
        "Client authenticated: solo-test-user" +
          (session.preferredLanguage
            ? ` (${session.preferredLanguage})`
            : " (no preferredLanguage)"),
      );

      sendToClient(clientSocket, {
        type: "auth_ok",
      });

      connectToGeminiLive(clientSocket, session);

      return;
    }

    // ========================================================
    // Everything below requires authenticated session
    // ========================================================

    if (!session.authed) {
      sendError(clientSocket, "Not authenticated");

      return;
    }

    // ========================================================
    // Ping
    // ========================================================

    if (msg.type === "ping") {
      sendToClient(clientSocket, {
        type: "pong",
      });

      return;
    }

    // ========================================================
    // Context
    //
    // Context is allowed before Gemini is ready.
    // ========================================================

    if (msg.type === "context") {
      if (msg.currentLocation) {
        session.currentLocation = msg.currentLocation;
      }

      if (msg.landmarks && msg.landmarks.length > 0) {
        session.landmarks = msg.landmarks;
      }

      // Gemini not ready yet.
      if (
        !session.geminiSocket ||
        session.geminiSocket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      sendContextToGemini(session, msg);

      return;
    }

    // ========================================================
    // Everything else requires Gemini ready
    // ========================================================

    if (
      !session.geminiSocket ||
      session.geminiSocket.readyState !== WebSocket.OPEN
    ) {
      sendError(clientSocket, "Gemini session not ready yet");

      return;
    }

    // ========================================================
    // Audio
    // ========================================================

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

    // ========================================================
    // Client interruption
    // ========================================================

    if (msg.type === "interrupt") {
      console.log("Client requested interruption");

      // Gemini Live handles interruption
      // through realtime input.
      return;
    }

    // ========================================================
    // Unknown message
    // ========================================================

    sendError(clientSocket, `Unknown message type: ${msg.type}`);
  });

  // ==========================================================
  // Client disconnected
  // ==========================================================

  clientSocket.on("close", () => {
    console.log("Client disconnected");

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

  // ==========================================================
  // Client socket error
  // ==========================================================

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

  // ----------------------------------------------------------
  // Landmarks
  // ----------------------------------------------------------

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
                parts: [
                  {
                    text: fullContext,
                  },
                ],
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

  // ----------------------------------------------------------
  // Current nearby landmarks
  // ----------------------------------------------------------

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
                parts: [
                  {
                    text: nearbyText,
                  },
                ],
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

  // ----------------------------------------------------------
  // Additional context
  // ----------------------------------------------------------

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

  // ==========================================================
  // Gemini socket opened
  // ==========================================================

  geminiSocket.on("open", () => {
    // Ignore stale socket
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
      "You are a concise Tbilisi tour guide in a real-time voice conversation. " +
      "Wait for the user to speak first. Do not start speaking automatically. " +
      "Once the user speaks, respond naturally and conversationally. " +
      "Keep answers concise and suitable for real-time voice conversation. " +
      "Avoid long monologues unless the user explicitly asks for detailed information. " +
      // ------------------------------------------------------
      // Local catalog
      // ------------------------------------------------------

      "You have access to a local landmark catalog, but it is NOT your only source. " +
      "The catalog is not guaranteed to be complete. " +
      "Never assume that a place or fact is unavailable merely because it is not in the catalog. " +
      "The landmark list contains names and types. " +
      "When the user asks for detailed history or description of a listed landmark, " +
      "call getLandmarkDetails. " +
      // ------------------------------------------------------
      // Google Search
      // ------------------------------------------------------

      "You also have access to the built-in Google Search tool. " +
      "Use Google Search when the user asks about a real-world place, landmark, restaurant, " +
      "cafe, hotel, shop, attraction, museum, street, neighborhood, event, business, " +
      "opening hours, prices, reviews, current information, or another factual topic " +
      "that is not sufficiently answered by the local catalog. " +
      "If getLandmarkDetails returns found:false, immediately use Google Search. " +
      "If a place is not in the local landmark catalog, do NOT say that you cannot find it. " +
      "Use Google Search to look for it. " +
      "Prefer Google Search over guessing whenever external information is needed. " +
      "Never invent factual information when Google Search can provide it. " +
      "Do not mention internal tools, APIs, databases, implementation details, " +
      "or catalog limitations to the user. " +
      // ------------------------------------------------------
      // Nearby places
      // ------------------------------------------------------

      "You can also use findNearbyPlaces for nearby restaurants, hotels, nightlife, " +
      "shopping, stores, cafes, gas stations, pharmacies, parks, public transport, and ATMs. " +
      "Use findNearbyPlaces when the user asks for nearby places or recommendations " +
      "based on their current location. " +
      // ------------------------------------------------------
      // Exact names
      // ------------------------------------------------------

      "When calling getLandmarkDetails, openPlaceOnMap, or showRouteToPlace, " +
      "use the exact place name returned by the landmark catalog or findNearbyPlaces. " +
      "Do not translate or transliterate the tool argument. " +
      // ------------------------------------------------------
      // Nearby recommendations
      // ------------------------------------------------------

      "If the user asks what is interesting nearby, use the nearby landmark context " +
      "when appropriate and recommend a small number of relevant places. " +
      // ------------------------------------------------------
      // Map
      // ------------------------------------------------------

      "If the user asks to see a specific place on the map, call openPlaceOnMap. " +
      "If the user wants directions or a route to a specific place, call showRouteToPlace. " +
      "Only call showRouteToPlace when the user clearly requests directions or a route. " +
      "Do not call it speculatively. " +
      // ------------------------------------------------------
      // Tool failures
      // ------------------------------------------------------

      "If getLandmarkDetails returns found:false, use Google Search instead of giving up. " +
      "If Google Search finds useful information, answer using that information. " +
      "If openPlaceOnMap or showRouteToPlace returns found:false, " +
      "do not expose internal implementation details. " +
      "If appropriate, use findNearbyPlaces to identify the correct place " +
      "and then retry using the verified exact name. " +
      // ------------------------------------------------------
      // Important web → map rule
      // ------------------------------------------------------

      "If you discover a specific place through Google Search and the user then asks to see it on the map " +
      "or get directions to it, use findNearbyPlaces first to resolve that place through Google Places " +
      "and obtain its coordinates. Then call openPlaceOnMap or showRouteToPlace with the exact returned name. " +
      // ------------------------------------------------------
      // Georgian century rule
      // ------------------------------------------------------

      "When speaking Georgian and referring to a century, use the correct ordinal form, " +
      "for example 'მეცამეტე საუკუნე', not 'ცამეტი საუკუნე'. " +
      // ------------------------------------------------------
      // Landmarks skeleton
      // ------------------------------------------------------

      (session.landmarks && session.landmarks.length > 0
        ? "\n\n" + buildLandmarksSkeletonText(session.landmarks)
        : "");

    // ========================================================
    // Gemini setup
    // ========================================================

    const setupMessage = {
      setup: {
        model: modelName,

        generationConfig: {
          responseModalities: ["AUDIO"],
        },

        // ------------------------------------------------------
        // Voice Activity Detection
        // ------------------------------------------------------

        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,

            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",

            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",

            prefixPaddingMs: 300,

            silenceDurationMs: 800,
          },
        },

        // ------------------------------------------------------
        // Context compression
        // ------------------------------------------------------

        contextWindowCompression: {
          slidingWindow: {},
        },

        // ------------------------------------------------------
        // Session resumption
        // ------------------------------------------------------

        sessionResumption: session.resumptionToken
          ? {
              handle: session.resumptionToken,
            }
          : {},

        // ------------------------------------------------------
        // System instruction
        // ------------------------------------------------------

        systemInstruction: {
          parts: [
            {
              text: systemInstructionText,
            },
          ],
        },

        // ------------------------------------------------------
        // Tools
        //
        // IMPORTANT:
        //
        // googleSearch is Gemini's BUILT-IN Google Search.
        //
        // toolDeclarations contains only our custom tools.
        // ------------------------------------------------------

        tools: [
          {
            googleSearch: {},
          },

          ...toolDeclarations,
        ],
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

  // ==========================================================
  // Messages from Gemini
  // ==========================================================

  geminiSocket.on("message", async (raw) => {
    // Ignore stale socket
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

    // ======================================================
    // Setup complete
    // ======================================================

    if (msg.setupComplete) {
      console.log("Gemini Live session ready");

      sendToClient(clientSocket, {
        type: "gemini_ready",

        needsLandmarks: !session.landmarks || session.landmarks.length === 0,
      });

      // ----------------------------------------------------
      // Context arrived before Gemini became ready
      // ----------------------------------------------------

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

    // ======================================================
    // Session resumption
    // ======================================================

    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;

      if (update.resumable && update.newHandle) {
        session.resumptionToken = update.newHandle;

        console.log("Gemini session resumption token updated");
      }

      return;
    }

    // ======================================================
    // Gemini API error
    // ======================================================

    if (msg.error) {
      console.error("Gemini API error:", JSON.stringify(msg.error));

      sendToClient(clientSocket, {
        type: "error",

        message: msg.error.message || "Gemini API error",
      });

      return;
    }

    // ======================================================
    // Custom tool calls
    //
    // NOTE:
    // Built-in googleSearch calls are handled internally
    // by Gemini and do NOT arrive here as our custom
    // function calls.
    // ======================================================

    if (msg.toolCall) {
      await handleGeminiToolCalls(
        clientSocket,
        geminiSocket,
        session,
        msg.toolCall,
      );

      return;
    }

    // ======================================================
    // Model response
    // ======================================================

    const serverContent = msg.serverContent;

    if (!serverContent) {
      return;
    }

    const parts = serverContent.modelTurn?.parts || [];

    // ======================================================
    // Timing diagnostics — first chunk of this turn
    // ======================================================

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

    // ======================================================
    // Model output
    // ======================================================

    for (const part of parts) {
      // ----------------------------------------------------
      // Audio
      // ----------------------------------------------------

      if (part.inlineData?.data) {
        sendToClient(clientSocket, {
          type: "audio",
          data: part.inlineData.data,
        });
      }

      // ----------------------------------------------------
      // Text
      // ----------------------------------------------------

      if (part.text) {
        sendToClient(clientSocket, {
          type: "text",
          data: part.text,
        });
      }
    }

    // ======================================================
    // Turn complete
    // ======================================================

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

    // ======================================================
    // Interrupted
    // ======================================================

    if (serverContent.interrupted) {
      sendToClient(clientSocket, {
        type: "turnEnd",
        interrupted: true,
      });
    }
  });

  // ==========================================================
  // Gemini socket error
  // ==========================================================

  geminiSocket.on("error", (error) => {
    console.error("Gemini Live socket error:", error.message);
  });

  // ==========================================================
  // Gemini socket close
  // ==========================================================

  geminiSocket.on("close", (code, reason) => {
    const reasonText = reason ? reason.toString() : "";

    console.log(
      `[TIMING] Gemini socket closed at ${new Date().toISOString()}: ${code}, reason: ${
        reasonText || "No reason provided"
      }`,
    );

    // Ignore stale connection
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

    // ======================================================
    // Reconnect
    // ======================================================

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
      }, 1000);

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

  // ==========================================================
  // Execute all custom calls
  // ==========================================================

  for (const call of functionCalls) {
    console.log(`Gemini tool call: ${call.name}`, call.args || {});

    let result;

    try {
      result = await executeTool(call.name, call.args || {}, session);
    } catch (error) {
      console.error(`Tool "${call.name}" execution error:`, error.message);

      result = {
        error: "tool_execution_failed",
      };
    }

    // ========================================================
    // Nearby places
    // ========================================================

    if (call.name === "findNearbyPlaces" && result && !result.error) {
      console.log("Nearby places search completed");
    }

    // ========================================================
    // Map actions
    // ========================================================

    if (
      (call.name === "openPlaceOnMap" || call.name === "showRouteToPlace") &&
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

    // ========================================================
    // Function response
    // ========================================================

    functionResponses.push({
      id: call.id,

      name: call.name,

      response: result || {
        error: "empty_tool_response",
      },
    });
  }

  // ==========================================================
  // Send all custom function responses together
  // ==========================================================

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

  console.log("Test authentication mode: ENABLED");
});
