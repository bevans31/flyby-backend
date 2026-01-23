// FlyBY Backend — SerpApi (Google Flights) only
// Supports: one-way + round-trip search
// Returns: flights[] + googleFlightsUrl + priceHistory
// Adds: bookingToken per flight + /amadeus/booking endpoint for deep-linking

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_GL = process.env.SERPAPI_GL || "us";
const SERPAPI_HL = process.env.SERPAPI_HL || "en";

if (!SERPAPI_KEY) {
  console.error("❌ Missing SERPAPI_KEY in environment variables");
  process.exit(1);
}

// -----------------------------
// 1) Search Flights (SerpApi)
// -----------------------------
async function searchFlightsSerpApi({
  origin,
  destination,
  date,
  returnDate,
  currency
}) {
  const url = new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("departure_id", origin.toUpperCase());
  url.searchParams.set("arrival_id", destination.toUpperCase());
  url.searchParams.set("outbound_date", date);
  url.searchParams.set("adults", "1");
  url.searchParams.set("currency", currency.toUpperCase());
  url.searchParams.set("gl", SERPAPI_GL);
  url.searchParams.set("hl", SERPAPI_HL);

  // ✅ Only set round-trip if returnDate exists
  if (returnDate && String(returnDate).trim().length > 0) {
    url.searchParams.set("type", "1"); // round-trip
    url.searchParams.set("return_date", String(returnDate).trim());
  } else {
    url.searchParams.set("type", "2"); // one-way
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SerpApi error ${res.status}: ${text}`);
  }
  return await res.json();
}

// -----------------------------
// 2) Booking Options (SerpApi)
//    Uses booking_token from flight result
// -----------------------------
async function fetchBookingFromSerpApi({ bookingToken, currency }) {
  const url = new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("booking_token", bookingToken); // ✅ deep-link flow
  url.searchParams.set("currency", currency.toUpperCase());
  url.searchParams.set("gl", SERPAPI_GL);
  url.searchParams.set("hl", SERPAPI_HL);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SerpApi booking_token error ${res.status}: ${text}`);
  }
  return await res.json();
}

// -----------------------------
// Flatten flights into your app’s shape
// Adds: bookingToken
// -----------------------------
function flattenFlights(serpJson, currency, max = 20) {
  const raw = [];
  if (Array.isArray(serpJson.best_flights)) raw.push(...serpJson.best_flights);
  if (Array.isArray(serpJson.other_flights)) raw.push(...serpJson.other_flights);

  const sliced = raw.slice(0, Math.min(max, 50));

  return sliced.map((f, idx) => {
    const segs = f.flights || [];
    const first = segs[0] || {};
    const last = segs[segs.length - 1] || {};

    const airline = (first.airline || "").toUpperCase();
    const flightNum = first.flight_number ? String(first.flight_number) : "";

    return {
      id: f.booking_token || `flight_${idx}`,
      bookingToken: f.booking_token || null, // ✅ NEW: required for deep link
      airline: airline,
      airlineName: airline,
      flightNumber: airline && flightNum ? `${airline}${flightNum}` : flightNum,
      departureIATA: first.departure_airport?.id || "",
      arrivalIATA: last.arrival_airport?.id || "",
      departureTime: first.departure_airport?.time || null,
      arrivalTime: last.arrival_airport?.time || null,
      price: f.price ? `${currency.toUpperCase()} ${f.price}` : null
    };
  });
}

// -----------------------------
// Health check
// -----------------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    provider: "serpapi",
    endpoints: ["/amadeus/flights", "/amadeus/booking"],
    env: { SERPAPI_KEY_present: !!SERPAPI_KEY }
  });
});

// -----------------------------
// Main flight search endpoint
// GET /amadeus/flights?origin=DTW&destination=ATL&date=2026-03-10&returnDate=...
// -----------------------------
app.get("/amadeus/flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      returnDate,
      currency = "USD",
      max = "20"
    } = req.query;

    if (!origin || !destination || !date) {
      return res.status(400).json({
        error: "Missing required params",
        required: ["origin", "destination", "date"]
      });
    }

    const safeMax = Math.min(parseInt(max, 10) || 20, 50);
    const safeCurrency = String(currency).toUpperCase();

    const serpJson = await searchFlightsSerpApi({
      origin,
      destination,
      date: String(date),
      returnDate: returnDate ? String(returnDate) : null,
      currency: safeCurrency
    });

    const flights = flattenFlights(serpJson, safeCurrency, safeMax);

    // ✅ Prefilled Google Flights link for the whole search
    const googleFlightsUrl = serpJson?.search_metadata?.google_flights_url || null;

    // ✅ Price history (useful for Fare Sniper)
    const priceHistory = serpJson?.price_insights?.price_history || null;

    return res.json({
      count: flights.length,
      googleFlightsUrl,
      priceHistory,
      flights
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// -----------------------------
// Deep-link booking endpoint
// GET /amadeus/booking?token=BOOKING_TOKEN&currency=USD
// This returns a googleFlightsUrl that is tied to the selected flight,
// plus booking options (links) if present.
// -----------------------------
app.get("/amadeus/booking", async (req, res) => {
  try {
    const { token, currency = "USD" } = req.query;

    if (!token) {
      return res.status(400).json({ error: "Missing token (bookingToken)" });
    }

    const safeCurrency = String(currency).toUpperCase();

    const bookingJson = await fetchBookingFromSerpApi({
      bookingToken: String(token),
      currency: safeCurrency
    });

    const googleFlightsUrl = bookingJson?.search_metadata?.google_flights_url || null;

    const bookingOptions = bookingJson?.booking_options || null;
    const selectedFlights = bookingJson?.selected_flights || null;

    return res.json({
      googleFlightsUrl,
      bookingOptions,
      selectedFlights
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 FlyBY backend running on port ${PORT}`);
});
