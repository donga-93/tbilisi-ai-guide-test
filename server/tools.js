// Tool declarations sent to Gemini Live at session setup.
// Gemini decides when to call these mid-conversation based on what the user says.

// ============================================================
// Fuzzy title matching
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
const MIN_TITLE_MATCH_SCORE = 0.45;

// Colloquial / shortened Georgian names → canonical title fragments.
// Keys are lower-case; values are extra substrings to match against titles.
const GEORGIAN_ALIASES = {
  ნარიყალა: ["narikala", "ნარიყალ"],
  სამება: ["sameba", "tsminda sameba", "trinity"],
  მეტეხი: ["metekhi"],
  მთაწმინდა: ["mtatsminda"],
  აბანოთუბანი: ["abano", "bath district"],
  პუშკინი: ["pushkin", "pushkini", "აბანოთუბან"],
  rustaveli: ["რუსთaveli", "rustavelis", "rustaveli avenue", "opera"],
  ფანვილი: ["fanvil", "dry bridge"],
  ლურჯი: ["blue mosque", "mosque"],
  ჩუღურეთი: ["chugureti"],
  დედაჩემი: ["kartlis deda", "mother of georgia"],
};

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
    .split(/[\s,.()!?;:„""'-]+/)
    .filter(Boolean);
}

function getSearchableNames(landmark) {
  const names = new Set();

  if (landmark.title) {
    names.add(landmark.title.toLowerCase().trim());
  }

  for (const alt of landmark.alternateTitles || []) {
    if (alt) {
      names.add(String(alt).toLowerCase().trim());
    }
  }

  // First token of the title (e.g. "ნარიყალა" from "ნარიყალას ციხe")
  const firstWord = (landmark.title || "").split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3) {
    names.add(firstWord.toLowerCase());
  }

  for (const [alias, hints] of Object.entries(GEORGIAN_ALIASES)) {
    const titleLower = (landmark.title || "").toLowerCase();
    const matchesLandmark =
      titleLower.includes(alias) ||
      hints.some((hint) => titleLower.includes(hint.toLowerCase()));

    if (matchesLandmark) {
      names.add(alias);
      for (const hint of hints) {
        names.add(hint.toLowerCase());
      }
    }
  }

  return [...names];
}

// Fraction of query words that found a case-tolerant match somewhere
// in the title. 1.0 = every query word matched something in the title.
function scoreTitleMatch(query, searchableName) {
  const queryWords = tokenize(query);
  const titleWords = tokenize(searchableName);

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

  // Fast path: exact substring match against any searchable name variant
  for (const landmark of landmarks) {
    for (const name of getSearchableNames(landmark)) {
      if (name.includes(query) || query.includes(name)) {
        console.log(
          `getLandmarkDetails: "${rawQuery}" → substring match "${landmark.title}" via "${name}"`,
        );
        return landmark;
      }
    }
  }

  let best = null;
  let bestScore = 0;
  let bestVia = "";

  for (const landmark of landmarks) {
    for (const name of getSearchableNames(landmark)) {
      const score = scoreTitleMatch(query, name);

      if (score > bestScore) {
        bestScore = score;
        best = landmark;
        bestVia = name;
      }
    }
  }

  const matched = best && bestScore >= MIN_TITLE_MATCH_SCORE ? best : null;

  console.log(
    `getLandmarkDetails: "${rawQuery}" → ` +
      (matched
        ? `fuzzy match "${matched.title}" via "${bestVia}" (score ${bestScore.toFixed(2)})`
        : `no match above threshold (best score ${bestScore.toFixed(2)}${best ? `, closest was "${best.title}"` : ""})`),
  );

  return matched;
}

// ============================================================
// findNearbyPlaces
// ============================================================

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DEFAULT_SEARCH_RADIUS_METERS = 1500;
const DEFAULT_MAX_RESULTS = 3;

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

  const results = places
    .filter((p) => p.location)
    .map((p) => ({
      name: p.displayName?.text || "Unknown",
      address: p.formattedAddress,
      rating: p.rating,
      distanceMeters: Math.round(haversineMeters(location, p.location)),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, maxResults);

  return { results };
}

const toolDeclarations = [
  {
    functionDeclarations: [
      {
        name: "findNearbyPlaces",
        description:
          "Finds places of a given category near the user's current location, sorted by distance. " +
          "Use this for restaurants, hotels, nightlife (bars/clubs), shopping malls, general stores, " +
          "cafes, gas stations, pharmacies, parks, public transport stops, or ATMs.",
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
          "Focuses the in-app map on a named place so the user can see where it is, without ending the conversation. Call this whenever the user asks to see, open, or be taken to a place mid-conversation.",
        parameters: {
          type: "OBJECT",
          properties: {
            placeId: {
              type: "STRING",
              description:
                'The Firebase placeId or a well-known place name (e.g. "narikala").',
            },
          },
          required: ["placeId"],
        },
      },
      {
        name: "showRouteToPlace",
        description:
          "Ends the voice conversation, switches to the map, and draws a route from the user's " +
          "current location to the named place. Only call this after you have discussed a specific " +
          "landmark and the user has explicitly confirmed they want directions/to see it on the map " +
          '(e.g. they said "yes", "show me", "sure"). Do not call this speculatively — always ask first.',
        parameters: {
          type: "OBJECT",
          properties: {
            placeId: {
              type: "STRING",
              description:
                'The Firebase placeId or the landmark name as discussed, e.g. "Narikala Fortress".',
            },
          },
          required: ["placeId"],
        },
      },
      {
        name: "getLandmarkDetails",
        description:
          'Returns the full description/history for a specific landmark by name. ALWAYS call this before describing a landmark in detail. Accepts Georgian or English names and common short forms (e.g. "ნარიყალა" for Narikala Fortress).',
        parameters: {
          type: "OBJECT",
          properties: {
            title: {
              type: "STRING",
              description:
                'The landmark name in any language or short form, e.g. "ნარიყალა", "Narikala Fortress".',
            },
          },
          required: ["title"],
        },
      },
    ],
  },
];

async function executeTool(name, args, session) {
  switch (name) {
    case "findNearbyPlaces": {
      if (!session.currentLocation) {
        return { error: "location_unavailable" };
      }

      const maxResults = args.maxResults || DEFAULT_MAX_RESULTS;

      return fetchNearbyPlaces(
        session.currentLocation,
        args.category,
        args.keyword,
        maxResults,
      );
    }
    case "openPlaceOnMap": {
      return { ok: true, placeId: args.placeId };
    }
    case "showRouteToPlace": {
      return { ok: true, placeId: args.placeId };
    }
    case "getLandmarkDetails": {
      const landmark = findLandmarkByTitle(session.landmarks, args.title);

      if (!landmark) {
        return { found: false };
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
