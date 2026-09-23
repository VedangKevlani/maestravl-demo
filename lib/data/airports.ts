/**
 * Curated subset of IATA airport codes. IATA codes are public identifiers
 * (not proprietary data), so this dictionary is free to embed and extend.
 * Weighted toward major global hubs + the Caribbean, matching Maestravl's focus.
 * For broader coverage later, this can be swapped for the free/open
 * openflights.org airports.dat without changing any calling code.
 *
 * lat/lng are approximate (airport reference point, a few hundred meters of
 * error) — fine for the coarse same-metro-area distance check in lib/uber.ts,
 * not precise enough for anything that needs real geocoding.
 *
 * timezone is the airport's real IANA zone — used by lib/dateFormat.ts's
 * resolveSegmentZones to render each end of a route-based segment in its
 * own actual local time (a flight's departure and arrival can genuinely be
 * in different zones, e.g. KIN/Jamaica vs MIA/New York).
 */
export const AIRPORTS: Record<string, { name: string; city: string; country: string; lat: number; lng: number; timezone: string }> = {
  KIN: { name: 'Norman Manley International', city: 'Kingston', country: 'Jamaica', lat: 17.9357, lng: -76.7875, timezone: 'America/Jamaica' },
  MBJ: { name: 'Sangster International', city: 'Montego Bay', country: 'Jamaica', lat: 18.5037, lng: -77.9134, timezone: 'America/Jamaica' },
  NAS: { name: 'Lynden Pindling International', city: 'Nassau', country: 'Bahamas', lat: 25.0389, lng: -77.4661, timezone: 'America/Nassau' },
  SJU: { name: 'Luis Muñoz Marín International', city: 'San Juan', country: 'Puerto Rico', lat: 18.4394, lng: -66.0018, timezone: 'America/Puerto_Rico' },
  POS: { name: 'Piarco International', city: 'Port of Spain', country: 'Trinidad and Tobago', lat: 10.5954, lng: -61.3372, timezone: 'America/Port_of_Spain' },
  BGI: { name: 'Grantley Adams International', city: 'Bridgetown', country: 'Barbados', lat: 13.0746, lng: -59.4925, timezone: 'America/Barbados' },
  AUA: { name: 'Queen Beatrix International', city: 'Oranjestad', country: 'Aruba', lat: 12.5014, lng: -70.0152, timezone: 'America/Aruba' },
  CUR: { name: 'Hato International', city: 'Willemstad', country: 'Curaçao', lat: 12.1889, lng: -68.9598, timezone: 'America/Curacao' },
  PUJ: { name: 'Punta Cana International', city: 'Punta Cana', country: 'Dominican Republic', lat: 18.5674, lng: -68.3634, timezone: 'America/Santo_Domingo' },
  SDQ: { name: 'Las Américas International', city: 'Santo Domingo', country: 'Dominican Republic', lat: 18.4297, lng: -69.6689, timezone: 'America/Santo_Domingo' },
  MIA: { name: 'Miami International', city: 'Miami', country: 'USA', lat: 25.7959, lng: -80.2870, timezone: 'America/New_York' },
  FLL: { name: 'Fort Lauderdale–Hollywood International', city: 'Fort Lauderdale', country: 'USA', lat: 26.0726, lng: -80.1527, timezone: 'America/New_York' },
  BOS: { name: 'Logan International', city: 'Boston', country: 'USA', lat: 42.3656, lng: -71.0096, timezone: 'America/New_York' },
  JFK: { name: 'John F. Kennedy International', city: 'New York', country: 'USA', lat: 40.6413, lng: -73.7781, timezone: 'America/New_York' },
  EWR: { name: 'Newark Liberty International', city: 'Newark', country: 'USA', lat: 40.6895, lng: -74.1745, timezone: 'America/New_York' },
  ATL: { name: 'Hartsfield–Jackson Atlanta International', city: 'Atlanta', country: 'USA', lat: 33.6407, lng: -84.4277, timezone: 'America/New_York' },
  ORD: { name: "O'Hare International", city: 'Chicago', country: 'USA', lat: 41.9742, lng: -87.9073, timezone: 'America/Chicago' },
  LAX: { name: 'Los Angeles International', city: 'Los Angeles', country: 'USA', lat: 33.9416, lng: -118.4085, timezone: 'America/Los_Angeles' },
  IAH: { name: 'George Bush Intercontinental', city: 'Houston', country: 'USA', lat: 29.9902, lng: -95.3368, timezone: 'America/Chicago' },
  YYZ: { name: 'Toronto Pearson International', city: 'Toronto', country: 'Canada', lat: 43.6777, lng: -79.6248, timezone: 'America/Toronto' },
  LHR: { name: 'Heathrow', city: 'London', country: 'UK', lat: 51.4700, lng: -0.4543, timezone: 'Europe/London' },
  LGW: { name: 'Gatwick', city: 'London', country: 'UK', lat: 51.1537, lng: -0.1821, timezone: 'Europe/London' },
  CDG: { name: 'Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lng: 2.5479, timezone: 'Europe/Paris' },
  AMS: { name: 'Schiphol', city: 'Amsterdam', country: 'Netherlands', lat: 52.3105, lng: 4.7683, timezone: 'Europe/Amsterdam' },
  FRA: { name: 'Frankfurt', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lng: 8.5622, timezone: 'Europe/Berlin' },
  MEX: { name: 'Mexico City International', city: 'Mexico City', country: 'Mexico', lat: 19.4363, lng: -99.0721, timezone: 'America/Mexico_City' },
  CUN: { name: 'Cancún International', city: 'Cancún', country: 'Mexico', lat: 21.0365, lng: -86.8771, timezone: 'America/Cancun' },
  BOG: { name: 'El Dorado International', city: 'Bogotá', country: 'Colombia', lat: 4.7016, lng: -74.1469, timezone: 'America/Bogota' },
  PTY: { name: 'Tocumen International', city: 'Panama City', country: 'Panama', lat: 9.0714, lng: -79.3834, timezone: 'America/Panama' },
  GCM: { name: 'Owen Roberts International', city: 'George Town', country: 'Cayman Islands', lat: 19.2928, lng: -81.3577, timezone: 'America/Cayman' },
  ANU: { name: 'V.C. Bird International', city: "St. John's", country: 'Antigua and Barbuda', lat: 17.1367, lng: -61.7928, timezone: 'America/Antigua' },
  SXM: { name: 'Princess Juliana International', city: 'Philipsburg', country: 'Sint Maarten', lat: 18.0410, lng: -63.1089, timezone: 'America/Lower_Princes' },
  GND: { name: 'Maurice Bishop International', city: "St. George's", country: 'Grenada', lat: 12.0042, lng: -61.7862, timezone: 'America/Grenada' },
  SLU: { name: 'Hewanorra International', city: 'Vieux Fort', country: 'Saint Lucia', lat: 13.7332, lng: -60.9527, timezone: 'America/St_Lucia' },
  UVF: { name: 'Hewanorra International', city: 'Vieux Fort', country: 'Saint Lucia', lat: 13.7332, lng: -60.9527, timezone: 'America/St_Lucia' },
}

export function lookupAirport(code: string): { name: string; city: string; country: string; lat: number; lng: number; timezone: string } | null {
  return AIRPORTS[code.toUpperCase()] ?? null
}
