// server.js — Clean, stable Amadeus flight flattening backend (ESM)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ENV
const CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const AMADEUS_BASE = "https://api.amadeus.com";

// Provider configuration. Default to SerpApi so the backend works out of the box.
// This can be changed to "amadeus" by setting FLYBY_PROVIDER=amadeus in your environment.
const PROVIDER = (process.env.FLYBY_PROVIDER || "serpapi").toLowerCase();
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_GL = process.env.SERPAPI_GL || "us";
const SERPAPI_HL = process.env.SERPAPI_HL || "en";

// Airline fallback names
const AIRLINE_MAP = {
  NK: "Spirit Airlines",
  F9: "Frontier Airlines",
  DL: "Delta Air Lines",
  AA: "American Airlines",
  UA: "United Airlines",
  WN: "Southwest Airlines",
  AS: "Alaska Airlines",
  B6: "JetBlue",
  SY: "Sun Country Airlines"
};

// Token cache
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && now < tokenExpiry - 30) {
    return cachedToken;
  }

  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!res.ok) {
    throw new Error("❌ Amadeus authentication failed");
  }

  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiry = Math.floor(Date.now() / 1000) + json.expires_in;

  return cachedToken;
}

/**
 * Perform a flight search against the SerpApi Google Flights engine.
 *
 * @param {Object} opts
 * @param {string} opts.origin        - The IATA code for the departure airport.
 * @param {string} opts.destination   - The IATA code for the arrival airport.
 * @param {string} opts.date          - Departure date in YYYY-MM-DD format.
 * @param {string} opts.currency      - ISO 4217 currency code (e.g. USD).
 * @returns {Promise<Object>} Raw JSON response from SerpApi.
 */
async function searchSerpApi({ origin, destination, date, currency }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("departure_id", origin.toUpperCase());
  url.searchParams.set("arrival_id", destination.toUpperCase());
  url.searchParams.set("outbound_date", date);
  // Only request one adult by default; adjust if needed.
  url.searchParams.set("adults", "1");
  url.searchParams.set("currency", currency.toUpperCase());
  url.searchParams.set("gl", SERPAPI_GL);
  url.searchParams.set("hl", SERPAPI_HL);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SerpApi error ${res.status}: ${detail}`);
  }
  return await res.json();
}

/**
 * Flatten SerpApi Google Flights response into the flight shape expected by the iOS app.
 * This function combines both "best_flights" and "other_flights" arrays.
 *
 * Each flight object returned will contain:
 * - id: unique identifier (booking token or generated)
 * - airline: two-letter code
 * - airlineName: same as airline (SerpApi doesn't provide full names consistently)
 * - flightNumber: airline + number (if available)
 * - departureIATA: departure airport code
 * - arrivalIATA: arrival airport code
 * - departureTime: ISO timestamp (if available)
 * - arrivalTime: ISO timestamp (if available)
 * - price: formatted price string with currency
 *
 * @param {Object} json     Raw JSON response from SerpApi
 * @param {string} currency Currency code used in the search
 * @param {number} [max]    Optional max number of flights to return
 * @param {Set<string>} [includeFilter] Optional set of airline codes to include
 * @returns {Array<Object>}
 */
function flattenSerpApi(json, currency, max, includeFilter) {
  // Flatten both best_flights and other_flights arrays.
  const flightsRaw = [];
  if (Array.isArray(json.best_flights)) flightsRaw.push(...json.best_flights);
  if (Array.isArray(json.other_flights)) flightsRaw.push(...json.other_flights);

  const flights = flightsRaw.map((f, idx) => {
    const segments = f.flights || [];
    const first = segments[0] || {};
    const last = segments[segments.length - 1] || first;

    const depAirport = first.departure_airport || {};
    const arrAirport = last.arrival_airport || {};
    const airlineCode = (first.airline || "").toUpperCase();
    const number = first.flight_number || "";

    // Attempt to get times; SerpApi may return local time string or ISO; we preserve as-is.
    const depTime = depAirport.time || null;
    const arrTime = arrAirport.time || null;

    const priceValue = f.price || null;
    const priceStr = priceValue ? `${currency.toUpperCase()} ${priceValue}` : null;

    return {
      id: f.booking_token || `${airlineCode}_${number}_${depAirport.id || ""}_${arrAirport.id || ""}_${idx}`,
      airline: airlineCode || "",
      airlineName: airlineCode || "",
      flightNumber: airlineCode && number ? `${airlineCode}${number}` : number || "",
      departureIATA: depAirport.id || "",
      arrivalIATA: arrAirport.id || "",
      departureTime: depTime,
      arrivalTime: arrTime,
      price: priceStr
    };
  });

  // Apply airline include filter if provided
  let filtered = flights;
  if (includeFilter && includeFilter.size > 0) {
    filtered = flights.filter(f => includeFilter.has(f.airline.toUpperCase()));
  }

  // Limit number of flights if max provided
  if (typeof max === "number" && !isNaN(max) && max > 0) {
    filtered = filtered.slice(0, max);
  }

  return filtered;
}

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    endpoint: "/amadeus/flights",
    env: {
      // Indicate whether required credentials are present based on provider
      AMADEUS_CLIENT_ID_present: !!CLIENT_ID,
      AMADEUS_CLIENT_SECRET_present: !!CLIENT_SECRET,
      SERPAPI_KEY_present: !!SERPAPI_KEY
    }
  });
});

// MAIN FLIGHT ROUTE
// This route serves as the entrypoint for flight searches from the iOS app.
// It uses either Amadeus or SerpApi depending on the value of FLYBY_PROVIDER.
app.get("/amadeus/flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      currency = "USD",
      max,
      include
    } = req.query;

    if (!origin || !destination || !date) {
      return res.status(400).json({ error: "Missing origin, destination, or date" });
    }

    const safeCurrency = currency.toUpperCase();
    const maxNum = Math.min(parseInt(max || "20", 10) || 20, 50);
    const includeSet = include ? new Set(include.split(",").map(s => s.trim().toUpperCase())) : null;

    if (PROVIDER === "amadeus") {
      // Ensure Amadeus credentials are available
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return res.status(500).json({
          error: "Amadeus credentials missing",
          detail: "Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET or change FLYBY_PROVIDER"
        });
      }

      const token = await getToken();

      // Build Amadeus URL
      const amUrl = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
      amUrl.searchParams.set("originLocationCode", origin.toUpperCase());
      amUrl.searchParams.set("destinationLocationCode", destination.toUpperCase());
      amUrl.searchParams.set("departureDate", date);
      amUrl.searchParams.set("adults", "1");
      amUrl.searchParams.set("max", maxNum.toString());
      amUrl.searchParams.set("currencyCode", safeCurrency);
      if (include) {
        amUrl.searchParams.set("includedAirlineCodes", include.toUpperCase());
      }

      const amadeusRes = await fetch(amUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!amadeusRes.ok) {
        return res.status(amadeusRes.status).json({
          error: "Amadeus returned an error",
          detail: await amadeusRes.text()
        });
      }

      const raw = await amadeusRes.json();
      const carriers = raw.dictionaries?.carriers || {};
      const offers = raw.data || [];

      let flights = offers.map(offer => {
        const seg = offer.itineraries?.[0]?.segments || [];
        const first = seg[0] || {};
        const last = seg[seg.length - 1] || {};

        const dep = first.departure || {};
        const arr = last.arrival || {};

        const carrier = first.carrierCode || offer.validatingAirlineCodes?.[0] || "";
        const airlineName = carriers[carrier] || AIRLINE_MAP[carrier] || carrier;

        return {
          id: offer.id || `${carrier}_${first.number}_${dep.iataCode}_${arr.iataCode}`,
          airline: carrier,
          airlineName,
          flightNumber: `${carrier}${first.number}`,
          departureIATA: dep.iataCode || "",
          arrivalIATA: arr.iataCode || "",
          departureTime: dep.at || null,
          arrivalTime: arr.at || null,
          price: offer.price?.total ? `${safeCurrency} ${offer.price.total}` : null
        };
      });

      // Apply airline include filter if provided (Amadeus can include filter too, but we apply after just in case)
      if (includeSet && includeSet.size > 0) {
        flights = flights.filter(f => includeSet.has(f.airline.toUpperCase()));
      }

      res.json({ count: flights.length, flights });
    } else if (PROVIDER === "serpapi") {
      // Ensure SerpApi key is available
      if (!SERPAPI_KEY) {
        return res.status(500).json({
          error: "SerpApi key missing",
          detail: "Set SERPAPI_KEY environment variable or change FLYBY_PROVIDER"
        });
      }
      // Call SerpApi and flatten response
      const serpJson = await searchSerpApi({ origin, destination, date, currency: safeCurrency });
      let flights = flattenSerpApi(serpJson, safeCurrency, maxNum, includeSet);
      res.json({ count: flights.length, flights });
    } else {
      // Unknown provider
      return res.status(500).json({ error: `Unknown provider '${PROVIDER}'` });
    }
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});