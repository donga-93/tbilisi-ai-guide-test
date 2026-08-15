// Tool declarations sent to Gemini Live at session setup.
// Gemini decides when to call these mid-conversation based on what the user says.

// ============================================================
// Fuzzy title matching (Task 2/4)
//
// Mirrors the proportional common-prefix approach already used
// client-side in AiGuideAssistant.tsx (wordsMatch/commonPrefixLength):
// Georgian grammatical case endings (-ის, -ში, -ზე, -თან, etc.) get
// appended to a word's stem, so a plain substring check on the raw
// title can miss valid matches. Comparing a proportional common
// prefix instead of the whole word tolerates those endings without
// needing real stemming.
// ============================================================

const MIN_COMMON_PREFIX_LENGTH = 3;
const MIN_COMMON_PREFIX_RATIO = 0.6;
const MIN_TITLE_MATCH_SCORE = 0.6;

function commonPrefixLength(a, b) {
  const maxLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < maxLen && a[i] === b[i]) i += 1;
  return i;
}

function wordsMatch(a, b) {
  const prefixLen = commonPrefixLength(a, b);
  const shorterLen = Math.min(a.length, b.length);
  return (
    prefixLen >= MIN_COMMON_PREFIX_LENGTH &&
    prefixLen >= shorterLen * MIN_COMMON_PREFIX_RATIO
  );
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[\s,.()!?;:„""-]+/)
    .filter(Boolean);
}

// Fraction of query words that found a case-tolerant match somewhere
// in the title. 1.0 = every query word matched something in the title.
function scoreTitleMatch(query, title) {
  const queryWords = tokenize(query);
  const titleWords = tokenize(title);

  if (queryWords.length === 0 || titleWords.length === 0) {
    return 0;
  }

  let matchedCount = 0;

  for (const queryWord of queryWords) {
    if (titleWords.some((titleWord) => wordsMatch(queryWord, titleWord))) {
      matchedCount += 1;
    }
  }

  return matchedCount / queryWords.length;
}

// Finds the best matching landmark for a free-form title query.
// 1) Fast path: exact substring match either direction — handles the
//    common case where Gemini echoes the title back verbatim.
// 2) Fallback: fuzzy word-level score across all landmarks, tolerant
//    of Georgian case-ending variation. Logs the decision so live
//    testing (Task 2) can confirm Gemini's calls are resolving right.
function findLandmarkByTitle(landmarks, rawQuery) {
  const query = (rawQuery || "").toLowerCase().trim();

  if (!query || !landmarks || landmarks.length === 0) {
    return null;
  }

  const exact = landmarks.find((l) => {
    const title = l.title.toLowerCase();
    return title.includes(query) || query.includes(title);
  });

  if (exact) {
    console.log(
      `findLandmarkByTitle: "${rawQuery}" → exact match "${exact.title}"`,
    );
    return exact;
  }

  let best = null;
  let bestScore = 0;

  for (const l of landmarks) {
    const score = scoreTitleMatch(query, l.title);

    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }

  const matched = best && bestScore >= MIN_TITLE_MATCH_SCORE ? best : null;

  console.log(
    `findLandmarkByTitle: "${rawQuery}" → ` +
      (matched
        ? `fuzzy match "${matched.title}" (score ${bestScore.toFixed(2)})`
        : `no match above threshold (best score ${bestScore.toFixed(2)}${best ? `, closest was "${best.title}"` : ""})`),
  );

  return matched;
}

// ============================================================
// Nearby-places cache (new)
//
// findNearbyPlaces used to hand Gemini a name/address/rating/
// distanceMeters summary and then forget the underlying Google
// Places results entirely — so if the user later said "open that
// on the map" / "show me directions there", there was no coordinate
// data anywhere to resolve it against (session.landmarks only ever
// holds the 23 curated Firestore landmarks, never Google search
// results). Caching each findNearbyPlaces call's results (with id +
// location) in the session lets openPlaceOnMap/showRouteToPlace
// resolve those too, not just landmarks.
// ============================================================

const NEARBY_CACHE_MAX_ENTRIES = 40;

function cacheNearbyPlaces(session, entries) {
  if (!entries || entries.length === 0) return;

  if (!session.nearbyPlacesCache) {
    session.nearbyPlacesCache = [];
  }

  const existingIds = new Set(session.nearbyPlacesCache.map((e) => e.id));

  for (const entry of entries) {
    if (!existingIds.has(entry.id)) {
      session.nearbyPlacesCache.push(entry);
    }
  }

  // Keeps the cache from growing unbounded across a long session —
  // only the most recently seen entries stay resolvable, which is
  // fine since the user is realistically only going to ask about
  // something they were just told about.
  if (session.nearbyPlacesCache.length > NEARBY_CACHE_MAX_ENTRIES) {
    session.nearbyPlacesCache = session.nearbyPlacesCache.slice(
      -NEARBY_CACHE_MAX_ENTRIES,
    );
  }
}

function findCachedPlaceByName(cache, rawQuery) {
  const query = (rawQuery || "").toLowerCase().trim();

  if (!query || !cache || cache.length === 0) {
    return null;
  }

  const exact = cache.find((p) => {
    const name = (p.name || "").toLowerCase();
    return name.includes(query) || query.includes(name);
  });

  if (exact) {
    console.log(
      `findCachedPlaceByName: "${rawQuery}" → exact match "${exact.name}"`,
    );
    return exact;
  }

  let best = null;
  let bestScore = 0;

  for (const p of cache) {
    const score = scoreTitleMatch(query, p.name || "");

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  const matched = best && bestScore >= MIN_TITLE_MATCH_SCORE ? best : null;

  console.log(
    `findCachedPlaceByName: "${rawQuery}" → ` +
      (matched
        ? `fuzzy match "${matched.name}" (score ${bestScore.toFixed(2)})`
        : `no match above threshold (best score ${bestScore.toFixed(2)}${best ? `, closest was "${best.name}"` : ""})`),
  );

  return matched;
}

// ============================================================
// Unified place resolution for openPlaceOnMap / showRouteToPlace
//
// Tries session.landmarks first (curated Firestore landmarks — the
// client already has full data for these and just needs the exact
// title back), then falls back to session.nearbyPlacesCache (Google
// Places results from a prior findNearbyPlaces call — the client has
// NO other source for these, so we hand back full coordinates too).
// ============================================================

function resolvePlaceReference(session, rawQuery) {
  const landmark = findLandmarkByTitle(session.landmarks, rawQuery);

  if (landmark) {
    return {
      found: true,
      source: "landmark",
      title: landmark.title,
    };
  }

  const cached = findCachedPlaceByName(session.nearbyPlacesCache, rawQuery);

  if (cached) {
    return {
      found: true,
      source: "google",
      title: cached.name,
      coordinates: cached.location,
      address: cached.address,
      googlePlaceId: cached.id,
      category: cached.category,
    };
  }

  return { found: false };
}

// ============================================================
// findNearbyPlaces (Task 3, generalized)
//
// Mirrors the Places API (New) pattern already used client-side
// in map.tsx (searchNearbyPlaces/searchPlacesByText): POST with
// X-Goog-Api-Key header + X-Goog-FieldMask, not the legacy
// query-string Places API.
//
// Uses its own server-side key (GOOGLE_PLACES_API_KEY) rather than
// the app-bundled EXPO_PUBLIC_GOOGLE_PLACES_REST_KEY — that one is
// restricted to the app's bundle id/referrer, which a backend
// server doesn't have, so it needs a separate key restricted by
// server IP instead. Add GOOGLE_PLACES_API_KEY to the server's .env.
//
// One generalized tool (category enum) instead of one function per
// place type — restaurant, hotel, nightlife, shopping, store, cafe,
// gas station, pharmacy, park, public transport, ATM all share the
// exact same Places API mechanics; only the includedType differs.
// ============================================================

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DEFAULT_SEARCH_RADIUS_METERS = 1500;
const DEFAULT_MAX_RESULTS = 3;

// category (what Gemini passes) → { Places API (New) includedType,
// human-readable label used to build free-text searchText queries }
const PLACE_CATEGORIES = {
  restaurant: { includedType: "restaurant", label: "restaurant" },
  hotel: { includedType: "lodging", label: "hotel" },
  nightlife: { includedType: "night_club", label: "nightclub or bar" },
  shopping: { includedType: "shopping_mall", label: "shopping mall" },
  store: { includedType: "store", label: "store" },
  cafe: { includedType: "cafe", label: "cafe" },
  gas_station: { includedType: "gas_station", label: "gas station" },
  pharmacy: { includedType: "pharmacy", label: "pharmacy" },
  park: { includedType: "park", label: "park" },
  transport: {
    includedType: "transit_station",
    label: "public transport station",
  },
  atm: { includedType: "atm", label: "ATM" },
};

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

const PLACES_FIELD_MASK =
  "places.id,places.displayName,places.location,places.formattedAddress,places.rating";

// ⬅️ CHANGE: now returns { results, cacheEntries } (or { error }) instead
// of just { results }. `results` is still the lightweight shape sent to
// Gemini (name/address/rating/distanceMeters — no need to spend tokens
// on ids/coordinates the model itself never uses). `cacheEntries` carries
// the id+location+category alongside, for cacheNearbyPlaces() to store
// server-side so a later openPlaceOnMap/showRouteToPlace call can
// resolve the same place by name.
async function fetchNearbyPlaces(location, category, keyword, maxResults) {
  if (!GOOGLE_PLACES_API_KEY) {
    console.error("GOOGLE_PLACES_API_KEY is not set — check the server .env");
    return { error: "place_search_unavailable" };
  }

  const categoryInfo = PLACE_CATEGORIES[category];

  if (!categoryInfo) {
    return {
      error: "unknown_category",
      validCategories: Object.keys(PLACE_CATEGORIES),
    };
  }

  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
    "X-Goog-FieldMask": PLACES_FIELD_MASK,
  };

  let places = [];

  try {
    if (keyword) {
      // Keyword is free text ("Georgian", "24 hour", "Carrefour", ...) —
      // includedTypes only covers a fixed enum, so a text query with
      // location bias is the more reliable way to filter within a category.
      const response = await fetch(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            textQuery: `${keyword} ${categoryInfo.label}`,
            maxResultCount: Math.max(maxResults, 10),
            locationBias: {
              circle: {
                center: location,
                radius: DEFAULT_SEARCH_RADIUS_METERS,
              },
            },
          }),
        },
      );

      const data = await response.json();
      places = data.places || [];
    } else {
      const response = await fetch(
        "https://places.googleapis.com/v1/places:searchNearby",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            includedTypes: [categoryInfo.includedType],
            maxResultCount: Math.max(maxResults, 10),
            locationRestriction: {
              circle: {
                center: location,
                radius: DEFAULT_SEARCH_RADIUS_METERS,
              },
            },
          }),
        },
      );

      const data = await response.json();
      places = data.places || [];
    }
  } catch (error) {
    console.error(
      "findNearbyPlaces: Places API request failed:",
      error.message,
    );
    return { error: "place_search_failed" };
  }

  const enriched = places
    .filter((p) => p.location)
    .map((p) => ({
      id: p.id,
      name: p.displayName?.text || "Unknown",
      address: p.formattedAddress,
      rating: p.rating,
      location: p.location,
      category,
      distanceMeters: Math.round(haversineMeters(location, p.location)),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, maxResults);

  return {
    results: enriched.map(
      ({ id, location: _location, category: _category, ...rest }) => rest,
    ),
    cacheEntries: enriched,
  };
}

const toolDeclarations = [
  {
    functionDeclarations: [
      {
        name: "findNearbyPlaces",
        description:
          "Finds places of a given category near the user's current location, sorted by distance. " +
          "Use this for restaurants, hotels, nightlife (bars/clubs), shopping malls, general stores, " +
          "cafes, gas stations, pharmacies, parks, public transport stops, or ATMs. " +
          "After telling the user about a result, you can call openPlaceOnMap or showRouteToPlace " +
          "with that result's exact name if the user wants to see it on the map or get directions.",
        parameters: {
          type: "OBJECT",
          properties: {
            category: {
              type: "STRING",
              enum: [
                "restaurant",
                "hotel",
                "nightlife",
                "shopping",
                "store",
                "cafe",
                "gas_station",
                "pharmacy",
                "park",
                "transport",
                "atm",
              ],
              description:
                "The category of place to search for. Pick the closest match to what the user asked for.",
            },
            keyword: {
              type: "STRING",
              description:
                'Optional free-text refinement within the category, e.g. "Georgian" or "Italian" ' +
                'for restaurant, "budget" or "5-star" for hotel, a brand name for store.',
            },
            maxResults: {
              type: "NUMBER",
              description: "Max number of results to return. Defaults to 3.",
            },
          },
          required: ["category"],
        },
      },
      {
        name: "openPlaceOnMap",
        description:
          "Focuses the in-app map on a named place so the user can see where it is, without ending the conversation. Call this whenever the user asks to see, open, or be taken to a place mid-conversation — whether it's one of the landmarks you were given, or a place you found for them via findNearbyPlaces.",
        parameters: {
          type: "OBJECT",
          properties: {
            placeId: {
              type: "STRING",
              description:
                "The place's exact name, exactly as it appeared either in the landmarks list you " +
                "were given for this session, or in a findNearbyPlaces result — same language, " +
                "same spelling. Do not translate or transliterate it into another script or " +
                "alphabet, even if the conversation itself is happening in a different language.",
            },
          },
          required: ["placeId"],
        },
      },
      {
        name: "showRouteToPlace",
        description:
          "Ends the voice conversation, switches to the map, and draws a route from the user's " +
          "current location to the named place — whether it's one of the landmarks you were given, " +
          "or a place you found for them via findNearbyPlaces. Only call this after you have " +
          "discussed a specific place and the user has explicitly confirmed they want directions/to " +
          'see it on the map (e.g. they said "yes", "show me", "sure"). Do not call this ' +
          "speculatively — always ask first.",
        parameters: {
          type: "OBJECT",
          properties: {
            placeId: {
              type: "STRING",
              description:
                "The place's exact name, exactly as it appeared either in the landmarks list you " +
                "were given for this session, or in a findNearbyPlaces result — same language, " +
                "same spelling. Do not translate or transliterate it into another script or " +
                "alphabet, even if the conversation itself is happening in a different language.",
            },
          },
          required: ["placeId"],
        },
      },
      {
        name: "getLandmarkDetails",
        description:
          'Returns the full description/history for a specific landmark by name. Call this when the user asks for details, history, or "tell me about" a place that was only briefly mentioned in the skeleton list.',
        parameters: {
          type: "OBJECT",
          properties: {
            title: {
              type: "STRING",
              description:
                "The landmark's exact name as it appears in the landmarks list you were given " +
                "for this session — same language, same spelling. Do not translate or " +
                "transliterate it into another script or alphabet, even if the conversation " +
                "itself is happening in a different language.",
            },
          },
          required: ["title"],
        },
      },
    ],
  },
];

/**
 * Executes a tool call from Gemini and returns the result to send back as a functionResponse.
 * `session` carries per-connection context (currentLocation, landmarks, nearbyPlacesCache, etc.
 * — wired in via the "context" message from GeminiLiveModal.tsx and via findNearbyPlaces calls
 * themselves; see server.js).
 *
 * findNearbyPlaces resolves data server-side (Google Places API), caches it (with coordinates)
 * in session.nearbyPlacesCache, and returns a lightweight summary to Gemini, for any of the
 * categories in PLACE_CATEGORIES (restaurant, hotel, nightlife, shopping, store, cafe,
 * gas_station, pharmacy, park, transport, atm).
 * openPlaceOnMap and showRouteToPlace resolve the requested name against BOTH session.landmarks
 * and session.nearbyPlacesCache via resolvePlaceReference before acking — the map lives on the
 * client, so beyond validating the match, the proxy also forwards a UI action event to the
 * client (see server.js's toolCall handler, which only does so when found !== false, and
 * forwards the resolved title — plus coordinates, for Google-sourced results the client has no
 * other way to look up).
 * getLandmarkDetails looks up a full description from session.landmarks, which the client
 * sends once at session start alongside the lightweight skeleton context.
 */
async function executeTool(name, args, session) {
  switch (name) {
    case "findNearbyPlaces": {
      if (!session.currentLocation) {
        // GeminiLiveModal.tsx sends currentLocation as part of its "context"
        // messages (initial fix + periodic GPS updates). If none has arrived
        // yet — permission not granted, or fix still pending — tell Gemini
        // rather than silently returning fabricated results.
        return { error: "location_unavailable" };
      }

      const maxResults = args.maxResults || DEFAULT_MAX_RESULTS;

      const { results, cacheEntries, error } = await fetchNearbyPlaces(
        session.currentLocation,
        args.category,
        args.keyword,
        maxResults,
      );

      if (error) {
        return { error };
      }

      cacheNearbyPlaces(session, cacheEntries);

      return { results };
    }
    case "openPlaceOnMap":
    case "showRouteToPlace": {
      // ⬅️ FIX: both actions now resolve through resolvePlaceReference,
      // which checks session.landmarks AND session.nearbyPlacesCache —
      // previously only openPlaceOnMap/showRouteToPlace against curated
      // landmarks worked at all; a findNearbyPlaces result (a restaurant,
      // cafe, etc.) had no coordinates stored anywhere and could never be
      // marked on the map, and any mismatch (translated/transliterated
      // name) used to still return a blind ok:true.
      const resolved = resolvePlaceReference(session, args.placeId);

      if (!resolved.found) {
        console.warn(
          `${name}: no match for "${args.placeId}" — available landmarks: ` +
            (session.landmarks || []).map((l) => l.title).join(", "),
        );

        return {
          found: false,
          message:
            `"${args.placeId}" ვერ მოიძებნა. ` +
            `ხელმისაწვდომი ღირსშესანიშნაობებია: ` +
            (session.landmarks || []).map((l) => l.title).join(", "),
        };
      }

      return { ok: true, ...resolved };
    }
    case "getLandmarkDetails": {
      const landmark = findLandmarkByTitle(session.landmarks, args.title);

      if (!landmark) {
        // Gemini-ს ვეუბნებით კონკრეტულად — დაბრუნდეს landmark სიაში
        // და სხვა მსგავსი სახელი სცადოს
        console.warn(
          `getLandmarkDetails: no match for "${args.title}" — available: ` +
            (session.landmarks || []).map((l) => l.title).join(", "),
        );
        return {
          found: false,
          message:
            `"${args.title}" ვერ მოიძებნა. ` +
            `ხელმისაწვდომი ღირსშესანიშნაობებია: ` +
            (session.landmarks || []).map((l) => l.title).join(", "),
        };
      }

      return {
        found: true,
        title: landmark.title,
        type: landmark.type,
        description: landmark.description,
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { toolDeclarations, executeTool };
