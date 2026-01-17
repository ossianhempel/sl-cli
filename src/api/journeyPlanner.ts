const BASE_URL = "https://journeyplanner.integration.sl.se/v2";

export type StopLocation = {
  id: string;
  label: string;
  coord: { lat: number; lon: number };
  type: "stop" | "address";
  matchQuality: number | undefined;
  isBest: boolean;
};

export type TripEndpointLocation =
  | { kind: "id"; id: string; label?: string; coord?: { lat: number; lon: number } }
  | { kind: "coord"; lat: number; lon: number };

export type TripLeg = {
  type: "walk" | "metro" | "train" | "tram" | "bus" | "ship";
  line?: string;
  direction?: string;
  departureTime: Date;
  arrivalTime: Date;
  durationSeconds: number;
  originName: string;
  destinationName: string;
  platform?: string;
};

export type TripProposal = {
  departureTime: Date;
  arrivalTime: Date;
  durationMinutes: number;
  walkToFirstLegSeconds: number;
  legs: TripLeg[];
  routeSummary: string;
};

export type TripSearchOptions = {
  numTrips?: number;
  dateTime?: Date;
  dateTimeMode?: "dep" | "arr";
  routeType?: "leasttime" | "leastinterchange" | "leastwalking";
  maxChanges?: number;
};

function formatCoordString(lat: number, lon: number): string {
  return `${lon}:${lat}:WGS84[dd.ddddd]`;
}

export async function searchLocations(query: string): Promise<StopLocation[]> {
  const url = new URL(`${BASE_URL}/stop-finder`);
  url.searchParams.set("name_sf", query);
  url.searchParams.set("type_sf", "any");
  url.searchParams.set("any_obj_filter_sf", "46");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Stop-finder failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseStopFinderResponse(data);
}

export async function resolveLocation(query: string): Promise<StopLocation | null> {
  const results = await searchLocations(query);
  if (results.length === 0) return null;

  const best = results.find((loc) => loc.isBest);
  if (best) return best;

  const sorted = [...results].sort((a, b) => (b.matchQuality || 0) - (a.matchQuality || 0));
  return sorted[0] || null;
}

export async function fetchTrips(
  origin: TripEndpointLocation,
  destination: TripEndpointLocation,
  options: TripSearchOptions = {}
): Promise<TripProposal[]> {
  const url = new URL(`${BASE_URL}/trips`);

  if (origin.kind === "coord") {
    url.searchParams.set("type_origin", "coord");
    url.searchParams.set("name_origin", formatCoordString(origin.lat, origin.lon));
  } else {
    url.searchParams.set("type_origin", "any");
    url.searchParams.set("name_origin", origin.id);
  }

  if (destination.kind === "coord") {
    url.searchParams.set("type_destination", "coord");
    url.searchParams.set("name_destination", formatCoordString(destination.lat, destination.lon));
  } else {
    url.searchParams.set("type_destination", "any");
    url.searchParams.set("name_destination", destination.id);
  }

  const requestedTrips = Math.min(Math.max(options.numTrips ?? 3, 1), 3);
  url.searchParams.set("calc_number_of_trips", String(requestedTrips));

  if (options.dateTime) {
    const date = formatItdDate(options.dateTime);
    const time = formatItdTime(options.dateTime);
    url.searchParams.set("itd_date", date);
    url.searchParams.set("itd_time", time);
    url.searchParams.set(
      "itd_trip_date_time_dep_arr",
      options.dateTimeMode === "arr" ? "arr" : "dep"
    );
  }

  if (options.routeType) {
    url.searchParams.set("route_type", options.routeType);
  }

  if (typeof options.maxChanges === "number") {
    url.searchParams.set("max_changes", String(options.maxChanges));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Trip search failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseTripsResponse(data);
}

function parseStopFinderResponse(data: unknown): StopLocation[] {
  const locations = (data as { locations?: Array<Record<string, unknown>> })?.locations;
  if (!Array.isArray(locations)) {
    return [];
  }

  const parsed = locations
    .map((loc) => {
      const id = typeof loc.id === "string" ? loc.id : null;
      const label = typeof loc.name === "string" ? loc.name : null;
      const coordRaw = Array.isArray(loc.coord) ? loc.coord : null;
      const typeRaw = typeof loc.type === "string" ? loc.type.toLowerCase() : "stop";
      const matchQuality = typeof loc.matchQuality === "number" ? loc.matchQuality : undefined;
      const isBest = Boolean(loc.isBest);

      if (!id || !label || !coordRaw || coordRaw.length < 2) {
        return null;
      }

      const lat = Number(coordRaw[0]);
      const lon = Number(coordRaw[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      const isAddress =
        typeRaw === "singlehouse" ||
        typeRaw === "address" ||
        typeRaw === "street" ||
        typeRaw === "poi";

      return {
        id,
        label,
        coord: { lat, lon },
        type: isAddress ? "address" : "stop",
        matchQuality,
        isBest,
      } satisfies StopLocation;
    })
    .filter((loc): loc is StopLocation => loc !== null);

  return parsed;
}

function parseTripsResponse(data: unknown): TripProposal[] {
  const journeys = (data as { journeys?: Array<Record<string, unknown>> })?.journeys;
  if (!Array.isArray(journeys)) {
    return [];
  }

  return journeys
    .map((journey) => parseJourneyToTripProposal(journey))
    .filter((t): t is TripProposal => t !== null);
}

function parseJourneyToTripProposal(journey: Record<string, unknown>): TripProposal | null {
  try {
    const rawLegs = journey.legs as unknown;
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
      return null;
    }

    const legsRaw: TripLeg[] = rawLegs
      .map((leg) => parseLegV2(leg as Record<string, unknown>))
      .filter((l): l is TripLeg => l !== null);

    if (legsRaw.length === 0) {
      return null;
    }

    const legs: TripLeg[] = [];
    for (const leg of legsRaw) {
      const lastLeg = legs[legs.length - 1];
      if (lastLeg && lastLeg.type === "walk" && leg.type === "walk") {
        lastLeg.arrivalTime = leg.arrivalTime;
        lastLeg.durationSeconds += leg.durationSeconds;
        lastLeg.destinationName = leg.destinationName;
      } else {
        legs.push(leg);
      }
    }

    let walkToFirstLegSeconds = 0;
    let firstTransportIndex = legs.findIndex((leg) => leg.type !== "walk");
    if (firstTransportIndex === -1) {
      firstTransportIndex = 0;
    } else {
      for (let i = 0; i < firstTransportIndex; i++) {
        walkToFirstLegSeconds += legs[i].durationSeconds;
      }
    }

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    const departureTime = firstLeg.departureTime;
    const arrivalTime = lastLeg.arrivalTime;

    const tripDurationSeconds =
      typeof journey.tripDuration === "number"
        ? journey.tripDuration
        : Math.max(0, Math.round((arrivalTime.getTime() - departureTime.getTime()) / 1000));
    const durationMinutes = Math.max(0, Math.round(tripDurationSeconds / 60));

    const routeSummary = buildRouteSummary(legs);

    return {
      departureTime,
      arrivalTime,
      durationMinutes,
      walkToFirstLegSeconds,
      legs,
      routeSummary,
    };
  } catch {
    return null;
  }
}

function parseLegV2(rawLeg: Record<string, unknown>): TripLeg | null {
  const origin = rawLeg.origin as Record<string, unknown> | undefined;
  const destination = rawLeg.destination as Record<string, unknown> | undefined;
  const transportation = rawLeg.transportation as Record<string, unknown> | undefined;

  if (!origin || !destination || !transportation) {
    return null;
  }

  const depTimeStr =
    (origin.departureTimeEstimated as string | undefined) ||
    (origin.departureTimePlanned as string | undefined) ||
    (origin.departureTimeBaseTimetable as string | undefined);
  const arrTimeStr =
    (destination.arrivalTimeEstimated as string | undefined) ||
    (destination.arrivalTimePlanned as string | undefined) ||
    (destination.arrivalTimeBaseTimetable as string | undefined);

  if (!depTimeStr || !arrTimeStr) {
    return null;
  }

  const departureTime = new Date(depTimeStr);
  const arrivalTime = new Date(arrTimeStr);

  const durationSeconds =
    typeof rawLeg.duration === "number"
      ? rawLeg.duration
      : Math.max(0, Math.round((arrivalTime.getTime() - departureTime.getTime()) / 1000));

  const product = transportation.product as Record<string, unknown> | undefined;
  const productName = (product?.name as string | undefined) || "";
  const type = mapTransportTypeV2(productName);

  const line =
    (transportation.disassembledName as string | undefined) ||
    (transportation.number as string | undefined) ||
    (transportation.name as string | undefined) ||
    undefined;

  const destObj = transportation.destination as Record<string, unknown> | undefined;
  const direction = (destObj?.name as string | undefined) || undefined;

  const originName = (origin.name as string | undefined) || "Unknown";
  const destinationName = (destination.name as string | undefined) || "Unknown";

  const originProps = origin.properties as Record<string, unknown> | undefined;
  const platform =
    (originProps?.platformName as string | undefined) ||
    (originProps?.platform as string | undefined) ||
    undefined;

  return {
    type,
    line,
    direction,
    departureTime,
    arrivalTime,
    durationSeconds,
    originName,
    destinationName,
    platform,
  };
}

function mapTransportTypeV2(productName: string): TripLeg["type"] {
  const normalized = productName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const upper = normalized.toUpperCase();

  if (upper.includes("FOOTPATH") || upper.includes("FOOT") || upper.includes("WALK")) {
    return "walk";
  }
  if (upper.includes("TUNNELBANA") || upper.includes("METRO")) {
    return "metro";
  }
  if (upper.includes("PENDEL") || upper.includes("TAG") || upper.includes("TRAIN")) {
    return "train";
  }
  if (upper.includes("SPARV") || upper.includes("TRAM")) {
    return "tram";
  }
  if (upper.includes("BAT") || upper.includes("SHIP") || upper.includes("FERRY")) {
    return "ship";
  }
  if (upper.includes("BUS")) {
    return "bus";
  }

  return "bus";
}

function buildRouteSummary(legs: TripLeg[]): string {
  const transportLegs = legs.filter((leg) => leg.type !== "walk");
  if (transportLegs.length === 0) {
    return "walk";
  }

  return transportLegs
    .map((leg) => `${leg.type}${leg.line ? ` ${leg.line}` : ""}`)
    .join(" -> ");
}

function formatItdDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function formatItdTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}
