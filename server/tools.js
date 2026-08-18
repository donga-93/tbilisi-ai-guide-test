// Tool declarations sent to Gemini Live at session setup.
//
// IMPORTANT:
// Google Search is a BUILT-IN Gemini Live tool.
// It is NOT declared here.
//
// It must be enabled in server.js like this:
//
// tools: [
//   { googleSearch: {} },
//   ...toolDeclarations,
// ]
//
// This allows Gemini to search the live web when:
// - the local landmark catalog does not contain the requested place
// - current information is required
// - the user asks about places, businesses, events, prices, hours, etc.
//
// Google Search is executed by Gemini itself.
// There is therefore NO custom "webSearch" function in this file.

// ============================================================
// Fuzzy title matching
// ============================================================

const MIN_COMMON_PREFIX_LENGTH = 3;
const MIN_COMMON_PREFIX_RATIO = 0.6;
const MIN_TITLE_MATCH_SCORE = 0.6;

function commonPrefixLength(a, b) {
  const maxLen = Math.min(a.length, b.length);
  let i = 0;

  while (i < maxLen && a[i] === b[i]) {
    i += 1;
  }

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
    .split(/[\s,.()!?;:„""\-]+/)
    .filter(Boolean);
}

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

function findLandmarkByTitle(landmarks, rawQuery) {
  const query = (rawQuery || "").toLowerCase().trim();

  if (!query || !landmarks || landmarks.length === 0) {
    return null;
  }

  // ----------------------------------------------------------
  // Exact substring match
  // ----------------------------------------------------------

  const exact = landmarks.find((l) => {
    const title = (l.title || "").toLowerCase();

    return title.includes(query) || query.includes(title);
  });

  if (exact) {
    console.log(
      `findLandmarkByTitle: "${rawQuery}" → exact match "${exact.title}"`,
    );

    return exact;
  }

  // ----------------------------------------------------------
  // Fuzzy match
  // ----------------------------------------------------------

  let best = null;
  let bestScore = 0;

  for (const l of landmarks) {
    const score = scoreTitleMatch(query, l.title || "");

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
        : `no match above threshold (best score ${bestScore.toFixed(2)}${
            best ? `, closest was "${best.title}"` : ""
          })`),
  );

  return matched;
}

// ============================================================
// Nearby places cache
// ============================================================

const NEARBY_CACHE_MAX_ENTRIES = 40;

function cacheNearbyPlaces(session, entries) {
  if (!entries || entries.length === 0) {
    return;
  }

  if (!session.nearbyPlacesCache) {
    session.nearbyPlacesCache = [];
  }

  const existingIds = new Set(session.nearbyPlacesCache.map((e) => e.id));

  for (const entry of entries) {
    if (!entry || !entry.id) {
      continue;
    }

    if (!existingIds.has(entry.id)) {
      session.nearbyPlacesCache.push(entry);
      existingIds.add(entry.id);
    }
  }

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

  // ----------------------------------------------------------
  // Exact substring match
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // Fuzzy match
  // ----------------------------------------------------------

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
        : `no match above threshold (best score ${bestScore.toFixed(2)}${
            best ? `, closest was "${best.name}"` : ""
          })`),
  );

  return matched;
}

// ============================================================
// Unified place resolution
//
// 1. Firestore landmark
// 2. Previously discovered Google Places result
//
// IMPORTANT:
// Google Search itself does not populate this cache.
// If Gemini finds a place through Google Search and later needs
// its coordinates for the map, Gemini should call
// findNearbyPlaces to resolve it through Google Places.
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

  return {
    found: false,
  };
}

// ============================================================
// findNearbyPlaces
//
// Uses Google Places API (New).
//
// This is separate from Gemini's built-in Google Search.
//
// findNearbyPlaces:
// - nearby structured place discovery
// - coordinates
// - distance
// - Google Place ID
//
// Google Search:
// - general web information
// - current facts
// - opening hours
// - prices
// - reviews
// - events
// - history
// - arbitrary factual information
// ============================================================

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const DEFAULT_SEARCH_RADIUS_METERS = 1500;
const DEFAULT_MAX_RESULTS = 3;

const PLACE_CATEGORIES = {
  restaurant: {
    includedType: "restaurant",
    label: "restaurant",
  },

  hotel: {
    includedType: "lodging",
    label: "hotel",
  },

  nightlife: {
    includedType: "night_club",
    label: "nightclub or bar",
  },

  shopping: {
    includedType: "shopping_mall",
    label: "shopping mall",
  },

  store: {
    includedType: "store",
    label: "store",
  },

  cafe: {
    includedType: "cafe",
    label: "cafe",
  },

  gas_station: {
    includedType: "gas_station",
    label: "gas station",
  },

  pharmacy: {
    includedType: "pharmacy",
    label: "pharmacy",
  },

  park: {
    includedType: "park",
    label: "park",
  },

  transport: {
    includedType: "transit_station",
    label: "public transport station",
  },

  atm: {
    includedType: "atm",
    label: "ATM",
  },
};

// ============================================================
// Distance calculation
// ============================================================

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

// ============================================================
// Google Places fields
// ============================================================

const PLACES_FIELD_MASK =
  "places.id,places.displayName,places.location,places.formattedAddress,places.rating";

// ============================================================
// Google Places request
// ============================================================

async function fetchNearbyPlaces(location, category, keyword, maxResults) {
  if (!GOOGLE_PLACES_API_KEY) {
    console.error("GOOGLE_PLACES_API_KEY is not set — check the server .env");

    return {
      error: "place_search_unavailable",
    };
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
    // ========================================================
    // Text search
    // ========================================================

    if (keyword) {
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

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          "findNearbyPlaces: Places searchText failed:",
          response.status,
          errorText,
        );

        return {
          error: "place_search_failed",
        };
      }

      const data = await response.json();

      places = data.places || [];
    }

    // ========================================================
    // Nearby search
    // ========================================================
    else {
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

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          "findNearbyPlaces: Places searchNearby failed:",
          response.status,
          errorText,
        );

        return {
          error: "place_search_failed",
        };
      }

      const data = await response.json();

      places = data.places || [];
    }
  } catch (error) {
    console.error(
      "findNearbyPlaces: Places API request failed:",
      error.message,
    );

    return {
      error: "place_search_failed",
    };
  }

  // ==========================================================
  // Normalize + sort by distance
  // ==========================================================

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

// ============================================================
// Gemini custom tool declarations
//
// IMPORTANT:
// Google Search is NOT here.
//
// Gemini built-in Google Search is enabled in server.js:
//
//   { googleSearch: {} }
//
// These are only OUR custom functions.
// ============================================================

const toolDeclarations = [
  {
    functionDeclarations: [
      // ======================================================
      // findNearbyPlaces
      // ======================================================

      {
        name: "findNearbyPlaces",

        description:
          "Finds real places near the user's current location using Google Places. " +
          "Use this for nearby restaurants, hotels, nightlife, shopping, stores, cafes, " +
          "gas stations, pharmacies, parks, public transport stops, or ATMs. " +
          "Use this when coordinates, distance, Google Place ID, or a map location are needed. " +
          "After finding a place, its exact name can be used with openPlaceOnMap or showRouteToPlace.",

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
                "The category of place to search for. Pick the closest match to what the user requested.",
            },

            keyword: {
              type: "STRING",

              description:
                'Optional free-text refinement, for example "Georgian", "Italian", "vegetarian", "budget", "5-star", or a specific brand name.',
            },

            maxResults: {
              type: "NUMBER",

              description:
                "Maximum number of results to return. Defaults to 3.",
            },
          },

          required: ["category"],
        },
      },

      // ======================================================
      // openPlaceOnMap
      // ======================================================

      {
        name: "openPlaceOnMap",

        description:
          "Focuses the in-app map on a specific place without ending the conversation. " +
          "Use this when the user explicitly asks to see or open a place on the map. " +
          "The place can be a local landmark or a Google Places result previously found by findNearbyPlaces. " +
          "Use the exact place name returned by the tools. " +
          "If a place was only discovered through Google Search and is not yet in the nearby-place cache, " +
          "first use findNearbyPlaces to resolve the place and obtain its coordinates, then call openPlaceOnMap.",

        parameters: {
          type: "OBJECT",

          properties: {
            placeId: {
              type: "STRING",

              description:
                "The exact place name returned by the landmark catalog or findNearbyPlaces. " +
                "Do not translate or transliterate it.",
            },
          },

          required: ["placeId"],
        },
      },

      // ======================================================
      // showRouteToPlace
      // ======================================================

      {
        name: "showRouteToPlace",

        description:
          "Ends the voice conversation, switches to the map, and draws a route from the user's current location to a specific place. " +
          "Only call this when the user explicitly asks for directions, a route, or to be taken there. " +
          "The place can be a local landmark or a Google Places result previously found by findNearbyPlaces. " +
          "If the place was only discovered through Google Search and is not yet in the nearby-place cache, " +
          "first use findNearbyPlaces to resolve the place and obtain its coordinates, then call showRouteToPlace. " +
          "Never call this speculatively.",

        parameters: {
          type: "OBJECT",

          properties: {
            placeId: {
              type: "STRING",

              description:
                "The exact place name returned by the landmark catalog or findNearbyPlaces. " +
                "Do not translate or transliterate it.",
            },
          },

          required: ["placeId"],
        },
      },

      // ======================================================
      // getLandmarkDetails
      // ======================================================

      {
        name: "getLandmarkDetails",

        description:
          "Returns the full local description and history for a specific landmark. " +
          "Use this when the user asks for details, history, background, or 'tell me about' a landmark " +
          "that appears in the local landmark catalog. " +
          "If the landmark is not in the local catalog, this function will return found:false. " +
          "When that happens, immediately use the built-in Google Search tool to find reliable external information. " +
          "Never tell the user that the place is unavailable merely because it is missing from the local catalog.",

        parameters: {
          type: "OBJECT",

          properties: {
            title: {
              type: "STRING",

              description:
                "The landmark's exact name as it appears in the landmark list. " +
                "Use the same language and spelling. Do not translate or transliterate it.",
            },
          },

          required: ["title"],
        },
      },
    ],
  },
];

// ============================================================
// Tool execution
//
// Only custom tools are executed here.
//
// Google Search is a Gemini-managed built-in tool.
// There is intentionally NO:
//
//   case "webSearch"
//
// and NO:
//
//   case "googleSearch"
//
// Gemini executes Google Search itself.
// ============================================================

async function executeTool(name, args, session) {
  switch (name) {
    // ========================================================
    // findNearbyPlaces
    // ========================================================

    case "findNearbyPlaces": {
      if (!session.currentLocation) {
        return {
          error: "location_unavailable",
        };
      }

      const requestedMaxResults = Number(args?.maxResults);

      const maxResults =
        Number.isFinite(requestedMaxResults) && requestedMaxResults > 0
          ? Math.min(Math.floor(requestedMaxResults), 10)
          : DEFAULT_MAX_RESULTS;

      const { results, cacheEntries, error } = await fetchNearbyPlaces(
        session.currentLocation,
        args?.category,
        args?.keyword,
        maxResults,
      );

      if (error) {
        return {
          error,
        };
      }

      cacheNearbyPlaces(session, cacheEntries);

      return {
        results,
      };
    }

    // ========================================================
    // openPlaceOnMap / showRouteToPlace
    // ========================================================

    case "openPlaceOnMap":
    case "showRouteToPlace": {
      const resolved = resolvePlaceReference(session, args?.placeId);

      if (!resolved.found) {
        console.warn(`${name}: no match for "${args?.placeId}"`);

        return {
          found: false,

          message:
            "The requested place could not be resolved from the current local landmark data or previously discovered Google Places. " +
            "If the place came from web search, use findNearbyPlaces first to resolve its exact Google Place and coordinates.",
        };
      }

      return {
        ok: true,
        ...resolved,
      };
    }

    // ========================================================
    // getLandmarkDetails
    // ========================================================

    case "getLandmarkDetails": {
      const landmark = findLandmarkByTitle(session.landmarks, args?.title);

      if (!landmark) {
        console.warn(`getLandmarkDetails: no local match for "${args?.title}"`);

        return {
          found: false,
        };
      }

      return {
        found: true,
        title: landmark.title,
        type: landmark.type,
        description: landmark.description,
      };
    }

    // ========================================================
    // Unknown tool
    // ========================================================

    default: {
      return {
        error: `Unknown tool: ${name}`,
      };
    }
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  toolDeclarations,
  executeTool,
};
