// Unified flight search backend with support for Amadeus and SerpApi (one-way and round-trip)

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

// Amadeus credentials and API base
const CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
const AMADEUS_BASE = 'https://api.amadeus.com';

// Provider configuration. Defaults to serpapi so no Amadeus keys are required unless explicitly set.
const PROVIDER = (process.env.FLYBY_PROVIDER || 'serpapi').toLowerCase();
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_GL = process.env.SERPAPI_GL || 'us';
const SERPAPI_HL = process.env.SERPAPI_HL || 'en';

// Optional server port
const PORT = process.env.PORT || 3000;

// Airline fallback names (for Amadeus responses)
const AIRLINE_MAP = {
  NK: 'Spirit Airlines',
  F9: 'Frontier Airlines',
  DL: 'Delta Air Lines',
  AA: 'American Airlines',
  UA: 'United Airlines',
  WN: 'Southwest Airlines',
  AS: 'Alaska Airlines',
  B6: 'JetBlue',
  SY: 'Sun Country Airlines'
};

// Token caching for Amadeus
let cachedToken = null;
let tokenExpiry = 0;

// Get OAuth token for Amadeus. Only used if provider is amadeus.
async function getToken() {
  if (PROVIDER !== 'amadeus') {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 30) {
    return cachedToken;
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing Amadeus credentials');
  }
  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });
  if (!res.ok) {
    throw new Error(`Amadeus auth failed ${res.status}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiry = Math.floor(Date.now() / 1000) + json.expires_in;
  return cachedToken;
}

// Perform a flight search against SerpApi's Google Flights engine.
// Supports optional returnDate (YYYY-MM-DD). If returnDate is provided, type=1 (round-trip) is used.
async function searchSerpApi({ origin, destination, date, returnDate, currency }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_flights');
  url.searchParams.set('api_key', SERPAPI_KEY);
  url.searchParams.set('departure_id', origin.toUpperCase());
  url.searchParams.set('arrival_id', destination.toUpperCase());
  url.searchParams.set('outbound_date', date);
  url.searchParams.set('adults', '1');
  url.searchParams.set('currency', currency.toUpperCase());
  url.searchParams.set('gl', SERPAPI_GL);
  url.searchParams.set('hl', SERPAPI_HL);
  if (returnDate) {
    url.searchParams.set('type', '1');
    url.searchParams.set('return_date', returnDate);
  } else {
    url.searchParams.set('type', '2');
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SerpApi error ${res.status}: ${detail}`);
  }
  return await res.json();
}

// Flatten SerpApi response into the flight shape expected by the app.
function flattenSerpApi(json, currency, max, includeFilter) {
  const flightsRaw = [];
  if (Array.isArray(json.best_flights)) flightsRaw.push(...json.best_flights);
  if (Array.isArray(json.other_flights)) flightsRaw.push(...json.other_flights);
  const flights = flightsRaw.map((f, idx) => {
    const segments = f.flights || [];
    const first = segments[0] || {};
    const last = segments[segments.length - 1] || first;
    const depAirport = first.departure_airport || {};
    const arrAirport = last.arrival_airport || {};
    const airlineCode = (first.airline || '').toUpperCase();
    const number = first.flight_number || '';
    const depTime = depAirport.time || null;
    const arrTime = arrAirport.time || null;
    const priceValue = f.price || null;
    const priceStr = priceValue ? `${currency.toUpperCase()} ${priceValue}` : null;
    return {
      id: f.booking_token || `${airlineCode}_${number}_${depAirport.id || ''}_${arrAirport.id || ''}_${idx}`,
      airline: airlineCode || '',
      airlineName: airlineCode || '',
      flightNumber: airlineCode && number ? `${airlineCode}${number}` : number || '',
      departureIATA: depAirport.id || '',
      arrivalIATA: arrAirport.id || '',
      departureTime: depTime,
      arrivalTime: arrTime,
      price: priceStr
    };
  });
  let filtered = flights;
  if (includeFilter && includeFilter.size > 0) {
    filtered = flights.filter(f => includeFilter.has(f.airline.toUpperCase()));
  }
  if (typeof max === 'number' && !isNaN(max) && max > 0) {
    filtered = filtered.slice(0, max);
  }
  return filtered;
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Root endpoint provides health status and environment info
app.get('/', (req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    endpoint: '/amadeus/flights',
    env: {
      AMADEUS_CLIENT_ID_present: !!CLIENT_ID,
      AMADEUS_CLIENT_SECRET_present: !!CLIENT_SECRET,
      SERPAPI_KEY_present: !!SERPAPI_KEY
    }
  });
});

// Main flight search route. Works for both Amadeus and SerpApi.
app.get('/amadeus/flights', async (req, res) => {
  try {
    const { origin, destination, date, returnDate, currency = 'USD', max, include } = req.query;
    if (!origin || !destination || !date) {
      return res.status(400).json({ error: 'Missing origin, destination, or date' });
    }
    const safeCurrency = currency.toUpperCase();
    const maxNum = Math.min(parseInt(max || '20', 10) || 20, 50);
    const includeSet = include ? new Set(include.split(',').map(s => s.trim().toUpperCase())) : null;

    if (PROVIDER === 'amadeus') {
      // At this time, only one-way searches are supported with Amadeus.
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return res.status(500).json({ error: 'Amadeus credentials missing', detail: 'Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET or change FLYBY_PROVIDER' });
      }
      const token = await getToken();
      const url = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
      url.searchParams.set('originLocationCode', origin.toUpperCase());
      url.searchParams.set('destinationLocationCode', destination.toUpperCase());
      url.searchParams.set('departureDate', date);
      url.searchParams.set('adults', '1');
      url.searchParams.set('max', maxNum.toString());
      url.searchParams.set('currencyCode', safeCurrency);
      if (include) {
        url.searchParams.set('includedAirlineCodes', include.toUpperCase());
      }
      const amRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!amRes.ok) {
        return res.status(amRes.status).json({ error: 'Amadeus returned an error', detail: await amRes.text() });
      }
      const raw = await amRes.json();
      const carriers = raw.dictionaries?.carriers || {};
      const offers = raw.data || [];
      let flights = offers.map(offer => {
        const seg = offer.itineraries?.[0]?.segments || [];
        const first = seg[0] || {};
        const last = seg[seg.length - 1] || {};
        const dep = first.departure || {};
        const arr = last.arrival || {};
        const carrier = first.carrierCode || offer.validatingAirlineCodes?.[0] || '';
        const airlineName = carriers[carrier] || AIRLINE_MAP[carrier] || carrier;
        return {
          id: offer.id || `${carrier}_${first.number}_${dep.iataCode}_${arr.iataCode}`,
          airline: carrier,
          airlineName,
          flightNumber: `${carrier}${first.number}`,
          departureIATA: dep.iataCode || '',
          arrivalIATA: arr.iataCode || '',
          departureTime: dep.at || null,
          arrivalTime: arr.at || null,
          price: offer.price?.total ? `${safeCurrency} ${offer.price.total}` : null
        };
      });
      if (includeSet && includeSet.size > 0) {
        flights = flights.filter(f => includeSet.has(f.airline.toUpperCase()));
      }
      return res.json({ count: flights.length, flights });
    } else if (PROVIDER === 'serpapi') {
      if (!SERPAPI_KEY) {
        return res.status(500).json({ error: 'SerpApi key missing', detail: 'Set SERPAPI_KEY environment variable or change FLYBY_PROVIDER' });
      }
      const serpJson = await searchSerpApi({ origin, destination, date, returnDate, currency: safeCurrency });
      const flights = flattenSerpApi(serpJson, safeCurrency, maxNum, includeSet);
      return res.json({ count: flights.length, flights });
    } else {
      return res.status(500).json({ error: `Unknown provider '${PROVIDER}'` });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});