// Standalone test client — sends a correctly-formed auth message to the proxy
// so we sidestep PowerShell's quote/bracket auto-editing when typing JSON by hand.
//
// Usage: node test-client.js
require("dotenv").config();
const WebSocket = require("ws");

const secret = process.env.PROXY_TEST_SECRET;
if (!secret) {
  console.error("PROXY_TEST_SECRET is not set in .env");
  process.exit(1);
}

const ws = new WebSocket("ws://localhost:8080/live");

ws.on("open", () => {
  console.log("connected, sending auth...");
  ws.send(JSON.stringify({ type: "auth", idToken: secret }));

  // A moment later, send one small "audio" chunk so we can see the round trip.
  // This isn't real PCM — just a tiny base64 blob to confirm the message is accepted.
  setTimeout(() => {
    console.log("sending a dummy audio chunk...");
    ws.send(JSON.stringify({ type: "audio", data: "AAAAAAAAAAAAAAAA" }));
  }, 1000);
});

ws.on("message", (raw) => {
  console.log("received:", raw.toString());
});

ws.on("close", (code, reason) => {
  console.log("closed:", code, reason.toString());
});

ws.on("error", (err) => {
  console.error("error:", err.message);
});
