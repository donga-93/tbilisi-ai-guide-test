# Gemini Live proxy

Stage 0 + Stage 2 of the voice-mode plan: a Node.js WebSocket relay that sits between
the Expo app and Gemini Live. Holds the Gemini API key server-side, verifies Firebase
auth, and handles tool calls (`findNearbyRestaurants`, `openPlaceOnMap`).

The React Native app (`AiGuideAssistant.tsx`) is **not touched** at this stage — this
runs and gets tested standalone first.

## Setup

```bash
npm install
cp .env.example .env
# fill in GEMINI_API_KEY and PROXY_TEST_SECRET in .env
npm start
```

Auth is intentionally minimal right now — no real users yet, just you testing. The
client sends `PROXY_TEST_SECRET` as the "idToken". When Google Sign-In is added
(subscriptions stage), only `auth.js` needs to change — see the comment at its top.

## Client <-> proxy protocol

The client connects to `ws://<host>:8080/live` and must send an auth message first:

```json
{ "type": "auth", "idToken": "<value of PROXY_TEST_SECRET for now>" }
```

After that, the client streams mic audio as base64 PCM16 (16kHz mono):

```json
{ "type": "audio", "data": "<base64 pcm16 chunk>" }
```

Optionally, to push updated location context (wired up fully in Stage 6):

```json
{ "type": "context", "currentLocation": { "lat": 41.69, "lng": 44.80 }, "nearbyPlaces": [...] }
```

Messages the proxy sends back to the client:

| type | meaning |
|---|---|
| `audio` | base64 PCM audio chunk to play (24kHz) |
| `text` | partial text from the model, if any |
| `action` | a UI action to perform, e.g. `{ name: "openPlaceOnMap", args: { placeId } }` |
| `turnEnd` | the model's turn finished, or was interrupted (`interrupted: true`) — stop/flush the playback queue |
| `error` | something went wrong |
| `sessionEnd` | the Gemini session closed |

## Testing without the app

Once running, you can test the proxy with a small `wscat` script or any WS client —
send the `auth` message, then a few `audio` chunks of silence/test PCM, and confirm you
get `audio` chunks back. This is the point to validate before touching the RN client.

## Notes / things to verify against current docs before shipping

- The exact Gemini Live WebSocket message shapes (`setup`, `realtimeInput`, `serverContent`,
  `toolCall`) are based on the documented Live API protocol — this is an actively evolving
  **preview** API, so double-check field names against `ai.google.dev/gemini-api/docs/live-api`
  before relying on this in production.
- `findNearbyRestaurants` currently returns stub data — wire it to your real Firestore/Places
  query, scoped by `session.currentLocation`, once Stage 6 context is flowing.
- No reconnect/backoff logic yet for the Gemini socket — add it once the happy path is verified.
- Add a per-session time limit (e.g. close after N minutes) before this goes live, since audio
  tokens are the priciest part of Gemini Live pricing.
