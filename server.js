// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

// ---- Amadeus API Setup ---- //
// force TEST base unless you explicitly override it
const AMADEUS_BASE =
  process.env.AMADEUS_BASE?.trim() || "https://test.api.amadeus.com";

const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;

if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
  console.warn("⚠️ Missing AMADEUS_CLIENT_ID or AMADEUS_CLIENT_SECRET in .env");
}

// get access token (no caching for now — fine while we test)
async function getAmadeusToken() {
  const response = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("❌ Amadeus token error:", data);
    throw new Error("Failed to get Amadeus token");
  }

  return data.access_token;
}

// simple health
app.get("/", (req, res) => {
  res.json({
    ok: true,
    amadeus_base: AMADEUS_BASE,
    endpoint: "/amadeus/flights",
  });
});

// ---- Available Flights ---- //
app.get("/amadeus/flights", async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({
      error: "Missing required parameters: origin, destination, date",
    });
  }

  try {
    const token = await getAmadeusToken();

    // ✅ use v2, not v1
    const url = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
    url.searchParams.set("originLocationCode", origin);
    url.searchParams.set("destinationLocationCode", destination);
    url.searchParams.set("departureDate", date);
    url.searchParams.set("adults", "1");
    url.searchParams.set("max", "5");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();

    // if Amadeus says “no apiproduct match found”, forward that so we know
    if (!response.ok) {
      console.error("❌ Amadeus flight error:", data);
      return res.status(response.status).json(data);
    }

    // success
    return res.json(data);
  } catch (error) {
    console.error("Error fetching Amadeus data:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ FlyBY backend running on http://localhost:${PORT}`)
);
