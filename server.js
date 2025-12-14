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
const AMADEUS_BASE = "https://.api.amadeus.com";

// Sanity check
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Missing AMADEUS_API_KEY or AMADEUS_API_SECRET in .env");
  process.exit(1);
}

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

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    endpoint: "/amadeus/flights",
    env: {
      CLIENT_ID_present: !!CLIENT_ID,
      CLIENT_SECRET_present: !!CLIENT_SECRET
    }
  });
});

// MAIN FLIGHT ROUTE
// MAIN FLIGHT ROUTE
app.get("/amadeus/flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      currency = "USD",
      max,            // raw query param from client (optional)
      include
    } = req.query;

    if (!origin || !destination || !date) {
      return res.status(400).json({ error: "Missing origin, destination, or date" });
    }

    const token = await getToken();

    // Decide how many offers to ask Amadeus for:
    // - If client passes &max=, use that
    // - Otherwise default to 20 instead of 5
    // - Clamp to at most 50 to avoid huge responses
    const maxSafe = Math.min(parseInt(max || "20", 10) || 20, 50).toString();

    // Build Amadeus URL
    const url = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
    url.searchParams.set("originLocationCode", origin.toUpperCase());
    url.searchParams.set("destinationLocationCode", destination.toUpperCase());
    url.searchParams.set("departureDate", date);
    url.searchParams.set("adults", "1");
    url.searchParams.set("max", maxSafe);
    url.searchParams.set("currencyCode", currency.toUpperCase());

    if (include) {
      url.searchParams.set("includedAirlineCodes", include.toUpperCase());
    }

    // Call Amadeus
    const amadeusRes = await fetch(url.toString(), {
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

    const flights = offers.map(offer => {
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
        price: offer.price?.total ? `${currency} ${offer.price.total}` : null
      };
    });

    res.json({
      count: flights.length,
      flights
    });
  } catch (err) {
    res.status(500).json({
      error: "Server error",
      detail: err.message
    });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
