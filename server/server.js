require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");

const { toolDeclarations, executeTool } = require("./tools");

// ============================================================
// Landmarks skeleton (Variant A)
//
// Only name+type get sent into Gemini's live context / system
// instruction — full descriptions stay in session.landmarks and
// are only surfaced on demand via the getLandmarkDetails tool.
// Keeps per-session token cost flat as the landmark catalog grows,
// and makes getLandmarkDetails/fuzzy matching actually exercised
// instead of permanently unreachable dead code.
// ============================================================

function buildLandmarksSkeletonText(landmarks) {
  if (!landmarks || landmarks.length === 0) return "";

  const lines = landmarks.map((l) => `- ${l.title} (${l.type})`).join("\n");

  return (
    "თბილისის ღირსშესანიშნაობების სია — თუ საუბარში რომელიმეს ახსენებენ, " +
    "გამოიყენე საორიენტაციოდ. დეტალური ინფორმაცია რომ დაგჭირდეს, " +
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
// NOTE ON MODEL CHOICE
//
// gemini-3.1-flash-live-preview has a known bug where
// realtimeInputConfig.automaticActivityDetection.silenceDurationMs
// is ignored server-side — it always ends the user's turn after
// a fixed internal silence threshold (roughly 2s), regardless of
// what you configure. In practice this makes it end (and then
// re-open) turns during completely normal speech pauses, which
// looks like a runaway audio/interrupt loop.
//
// gemini-2.5-flash-native-audio-latest respects this setting
// correctly. Switch back to a 3.1 model only once Google fixes
// https://github.com/googleapis/js-genai/issues/1467.
// ============================================================

// ============================================================
// Gemini Live WebSocket endpoint
// ============================================================

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta." +
  "GenerativeService.BidiGenerateContent" +
  `?key=${GEMINI_API_KEY}`;

// ============================================================
// Validate environment
// ============================================================

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set — check your .env");

  process.exit(1);
}

// ============================================================
// HTTP + WebSocket server
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
  console.log("client connected");

  // ==========================================================
  // TEST MODE
  //
  // Firebase authentication is intentionally disabled.
  // Only you are testing the application at this stage.
  // ==========================================================

  const session = {
    authed: true,
    uid: "solo-test-user",
    geminiSocket: null,
    currentLocation: null,
    landmarks: null,
    resumptionToken: null,
    reconnecting: false,
    landmarksInjected: false,
  };

  console.log("client authed: solo-test-user");

  // ==========================================================
  // Tell React Native that test authentication succeeded
  // ==========================================================

  sendToClient(clientSocket, {
    type: "auth_ok",
  });

  // ==========================================================
  // Immediately connect to Gemini Live
  // ==========================================================

  connectToGeminiLive(clientSocket, session);

  // ==========================================================
  // Messages from React Native client
  // ==========================================================

  clientSocket.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid client JSON:", error.message);

      return sendError(clientSocket, "Malformed JSON");
    }

    // ========================================================
    // Ignore auth message from frontend
    // ========================================================

    if (msg.type === "auth") {
      console.log("Test client auth message received — Firebase auth skipped");

      return;
    }

    // ========================================================
    // Gemini connection must be ready
    // ========================================================

    if (
      !session.geminiSocket ||
      session.geminiSocket.readyState !== WebSocket.OPEN
    ) {
      return sendError(clientSocket, "Gemini session not ready yet");
    }

    // ========================================================
    // Client message types
    // ========================================================

    switch (msg.type) {
      // ------------------------------------------------------
      // Audio from phone microphone
      // ------------------------------------------------------

      case "audio": {
        if (!msg.data) {
          return sendError(clientSocket, "Audio data is missing");
        }

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

        break;
      }

      // ------------------------------------------------------
      // Context update
      //
      // Sent as a clientContent turn with turnComplete: false
      // instead of realtimeInput.text.
      //
      // realtimeInput.text is treated by Gemini as spoken user
      // input, so pushing GPS/location updates through it mid
      // conversation could make the model think the user just
      // said something and try to respond out loud to it.
      //
      // turnComplete: false attaches this content to context
      // without closing a conversational turn, so Gemini folds
      // it in silently and only responds once the user's next
      // real (turnComplete: true) turn arrives.
      //
      // Also used by GeminiLiveModal.tsx to push a lightweight
      // landmarks "skeleton" (name+type) once at session start.
      // The structured msg.landmarks array (title/type/description)
      // is stored in session.landmarks so the getLandmarkDetails
      // tool (tools.js) can look up full descriptions on demand.
      // ------------------------------------------------------

      case "context": {
        session.currentLocation =
          msg.currentLocation || session.currentLocation;

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
            console.log(
              "📍 Landmarks skeleton sent:",
              msg.landmarks.length,
              "items",
            );
          } catch (error) {
            console.error("Failed to send landmark context:", error.message);
          }
        }

        // ------------------------------------------------------
        // Nearby-landmarks proximity update (Stage 6 / GPS)
        //
        // Sent periodically by GeminiLiveModal.tsx as the user's
        // location changes meaningfully during a Live session.
        // Lightweight — just titles, not full descriptions (those
        // were already injected once via msg.landmarks above).
        // Keeps Gemini's attention on what's actually close by
        // without re-paying the token cost of the full landmark
        // corpus on every GPS tick.
        // ------------------------------------------------------

        if (msg.nearbyLandmarks && msg.nearbyLandmarks.length > 0) {
          const nearbyText =
            `[SYSTEM CONTEXT — not spoken by user]\n` +
            `მომხმარებელი ახლა ახლოს არის შემდეგ ღირსშესანიშნაობებთან, ` +
            `მანძილის მიხედვით დალაგებული: ${msg.nearbyLandmarks.join(", ")}. ` +
            `თუ საუბარში მოსახერხებელია, გაითვალისწინე რეკომენდაციებში.`;

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
            console.log(
              "📍 Nearby landmarks context updated:",
              msg.nearbyLandmarks.join(", "),
            );
          } catch (error) {
            console.error(
              "Failed to send nearby-landmarks context:",
              error.message,
            );
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
                          text: `[SYSTEM CONTEXT — not spoken by user] ${msg.text}`,
                        },
                      ],
                    },
                  ],
                  turnComplete: false,
                },
              }),
            );
          } catch (error) {
            console.error(
              "Failed to send context text to Gemini:",
              error.message,
            );
          }
        }

        break;
      }

      // ------------------------------------------------------
      // Client interruption
      // ------------------------------------------------------

      case "interrupt": {
        console.log("Client requested interruption");

        /*
         * Do not send audioStreamEnd here.
         *
         * Gemini Live handles realtime interruption
         * through the realtime audio stream / VAD.
         */

        break;
      }

      // ------------------------------------------------------
      // Ping
      // ------------------------------------------------------

      case "ping": {
        sendToClient(clientSocket, {
          type: "pong",
        });

        break;
      }

      // ------------------------------------------------------
      // Unknown message
      // ------------------------------------------------------

      default: {
        sendError(clientSocket, `Unknown message type: ${msg.type}`);
      }
    }
  });

  // ==========================================================
  // Client disconnected
  // ==========================================================

  clientSocket.on("close", () => {
    console.log("client disconnected");

    const geminiSocket = session.geminiSocket;

    // Mark session dead so the Gemini "close" handler does NOT
    // attempt an automatic reconnect after the user has left.
    session.geminiSocket = null;
    session.reconnecting = false;

    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) {
      try {
        geminiSocket.close(1000, "Client disconnected");
      } catch (error) {
        console.error("Error closing Gemini socket:", error.message);
      }
    }
  });

  // ==========================================================
  // Client WebSocket error
  // ==========================================================

  clientSocket.on("error", (error) => {
    console.error("Client WebSocket error:", error.message);
  });
});

// ============================================================
// Connect to Gemini Live
//
// Pass resumptionToken (string | null) to resume a previous
// session. On a fresh connection pass null (or omit it).
// ============================================================

function connectToGeminiLive(clientSocket, session) {
  console.log(
    session.resumptionToken
      ? `Reconnecting to Gemini Live (resumption token present)…`
      : "Connecting to Gemini Live…",
  );

  const geminiSocket = new WebSocket(GEMINI_LIVE_URL);

  session.geminiSocket = geminiSocket;
  session.reconnecting = false;

  // ==========================================================
  // Gemini WebSocket opened
  // ==========================================================

  geminiSocket.on("open", () => {
    console.log("Connected to Gemini Live");

    const modelName = GEMINI_MODEL.startsWith("models/")
      ? GEMINI_MODEL
      : `models/${GEMINI_MODEL}`;

    console.log(`Starting Gemini model: ${modelName}`);

    // ========================================================
    // Gemini Live setup
    // ========================================================

    const setupMessage = {
      setup: {
        model: modelName,

        generationConfig: {
          responseModalities: ["AUDIO"],
        },

        // ------------------------------------------------------
        // Voice activity detection tuning
        //
        // startOfSpeechSensitivity LOW / prefixPaddingMs: reduces
        // false "user started talking" triggers from background
        // noise or mic self-noise.
        //
        // silenceDurationMs: how long a pause has to be before
        // the model treats the user's turn as finished. Raised
        // above the ~2s default so normal mid-sentence pauses
        // don't get cut off. (Only effective on 2.5-class
        // models — ignored on gemini-3.1-flash-live-preview,
        // see note above GEMINI_MODEL.)
        // ------------------------------------------------------

        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            prefixPaddingMs: 300,
            silenceDurationMs: 600,
          },
        },

        // ------------------------------------------------------
        // Session resumption
        //
        // Asking Gemini to send us a resumption token after each
        // turn (transparent: false would only send one on close).
        // On reconnect we pass the last stored token so Gemini
        // can restore conversation context without the client
        // needing to know anything happened.
        // ------------------------------------------------------

        sessionResumption: session.resumptionToken
          ? { handle: session.resumptionToken }
          : {},

        // ------------------------------------------------------
        // System instruction
        //
        // "Wait for the user to speak first" is critical:
        // without it Gemini sends an unsolicited greeting the
        // moment the session opens, before the mic stream has
        // started. That greeting arrives as audio chunks which
        // trigger the mic to start — and the overlap causes
        // Gemini's VAD to detect the playback signal as user
        // speech, interrupting itself immediately.
        // ------------------------------------------------------

        systemInstruction: {
          parts: [
            {
              text:
                "You are a concise Tbilisi tour guide in a real-time voice conversation. " +
                "Wait for the user to speak first — do not say anything until the user speaks. " +
                "Once the user speaks, match their language exactly. " +
                "When speaking Georgian and referring to a century, always use " +
                "the correct ordinal form (e.g. 'მეცამეტე საუკუნე', not " +
                "'ცამეტი საუკუნე' or 'ცამეტს საუკუნეს'). " +
                "Keep all answers short and conversational. " +
                "Avoid long monologues. " +
                "You only have landmark names and types below, not full " +
                "descriptions — call getLandmarkDetails whenever the user " +
                "asks about a specific landmark's history or details. " +
                "If the user asks what's interesting nearby, suggest a couple of the " +
                "closest landmarks below (they're already ordered by distance) and briefly " +
                "say why each is worth seeing. " +
                "After you finish describing a specific landmark in any detail, ask the user " +
                "if they'd like to see it on the map with directions (e.g. 'Would you like " +
                "directions there?'). If they confirm (\"yes\", \"show me\", \"sure\", etc.), " +
                "call showRouteToPlace with that landmark's name — do not call it unless the " +
                "user has explicitly confirmed. If the user asks to see a place on the map " +
                "without asking for directions, call openPlaceOnMap instead, which keeps the " +
                "conversation going." +
                (session.landmarks && session.landmarks.length > 0
                  ? "\n\n" + buildLandmarksSkeletonText(session.landmarks)
                  : ""),
            },
          ],
        },

        tools: toolDeclarations,
      },
    };

    try {
      geminiSocket.send(JSON.stringify(setupMessage));
    } catch (error) {
      console.error("Failed to send Gemini setup:", error.message);
    }
  });

  // ==========================================================
  // Messages from Gemini
  // ==========================================================

  geminiSocket.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid Gemini message:", error.message);

      return;
    }

    // ======================================================
    // Gemini setup complete
    // ======================================================

    if (msg.setupComplete) {
      console.log("Gemini Live session ready");

      sendToClient(clientSocket, {
        type: "gemini_ready",
        needsLandmarks: !session.landmarks,
      });

      return;
    }

    // ======================================================
    // Session resumption token update
    //
    // Gemini sends this after each turn (because we set
    // sessionResumption: {} in setup). Store the latest token
    // so it is available immediately if a reconnect is needed.
    //
    // resumable: false means this particular snapshot cannot be
    // used to resume — just ignore those and keep the last good
    // token.
    // ======================================================

    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;

      if (update.resumable && update.newHandle) {
        session.resumptionToken = update.newHandle;
        console.log("Session resumption token updated");
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
    // Gemini tool calls
    // ======================================================

    if (msg.toolCall) {
      try {
        const functionCalls = msg.toolCall.functionCalls || [];

        for (const call of functionCalls) {
          console.log(`Gemini tool call: ${call.name}`);

          const result = await executeTool(call.name, call.args, session);

          // ----------------------------------------------
          // Send action to React Native
          // ----------------------------------------------

          if (call.name === "openPlaceOnMap" || call.name === "showRouteToPlace") {
            sendToClient(clientSocket, {
              type: "action",
              name: call.name,
              args: call.args,
            });
          }

          // ----------------------------------------------
          // Send tool response back to Gemini
          // ----------------------------------------------

          if (geminiSocket.readyState === WebSocket.OPEN) {
            geminiSocket.send(
              JSON.stringify({
                toolResponse: {
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name,
                      response: result,
                    },
                  ],
                },
              }),
            );
          }
        }
      } catch (error) {
        console.error("Tool execution error:", error.message);
      }

      return;
    }

    // ======================================================
    // Gemini model response
    // ======================================================

    const serverContent = msg.serverContent;

    const parts = serverContent?.modelTurn?.parts || [];

    // ======================================================
    // Forward Gemini response parts
    // ======================================================

    for (const part of parts) {
      // -----------------------------------------------
      // Audio
      // -----------------------------------------------

      if (part.inlineData?.data) {
        sendToClient(clientSocket, {
          type: "audio",
          data: part.inlineData.data,
        });
      }

      // -----------------------------------------------
      // Text
      // -----------------------------------------------

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

    if (serverContent?.turnComplete) {
      sendToClient(clientSocket, {
        type: "turnEnd",
        interrupted: false,
      });
    }

    // ======================================================
    // Gemini interrupted
    // ======================================================

    if (serverContent?.interrupted) {
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

    // The "close" event will fire right after — let it handle
    // the reconnect so we don't attempt two reconnects for one
    // failure.
  });

  // ==========================================================
  // Gemini socket closed
  // ==========================================================

  geminiSocket.on("close", (code, reason) => {
    const reasonText = reason ? reason.toString() : "";

    console.log(
      `Gemini Live socket closed: ${code}, reason: ${
        reasonText || "No reason provided"
      }`,
    );

    if (session.geminiSocket === geminiSocket) {
      session.geminiSocket = null;
    }

    // --------------------------------------------------------
    // Auto-reconnect while the client is still connected
    //
    // clientSocket.readyState === OPEN  — user is still there
    // !session.reconnecting             — no reconnect in flight
    //
    // Code 1000 with the reason "Client disconnected" means WE
    // closed the socket intentionally — skip reconnect in that
    // case.
    // --------------------------------------------------------

    const intentionalClose =
      code === 1000 && reasonText === "Client disconnected";

    if (
      !intentionalClose &&
      !session.reconnecting &&
      clientSocket.readyState === WebSocket.OPEN
    ) {
      session.reconnecting = true;

      console.log(
        session.resumptionToken
          ? "Scheduling reconnect with resumption token…"
          : "Scheduling reconnect (no token — fresh session)…",
      );

      // Small delay so rapid error+close pairs don't stack up.
      setTimeout(() => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          connectToGeminiLive(clientSocket, session);
        } else {
          session.reconnecting = false;
        }
      }, 1000);

      return;
    }

    // --------------------------------------------------------
    // Intentional close or client already gone — tell client
    // --------------------------------------------------------

    sendToClient(clientSocket, {
      type: "sessionEnd",
      code,
      reason: reasonText,
    });
  });
}

// ============================================================
// Send message safely to React Native
// ============================================================

function sendToClient(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("Failed to send message to client:", error.message);
    }
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

  console.log("Test authentication mode: ENABLED");
});