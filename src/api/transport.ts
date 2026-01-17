const BASE_URL = "https://transport.integration.sl.se/v1";

export type TransportSite = {
  id: string;
  name: string;
  coord?: { lat: number; lon: number };
  products: string[];
};

export type Departure = {
  type: "metro" | "train" | "tram" | "bus" | "ship";
  line: string;
  destination: string;
  scheduledTime: Date;
  expectedTime: Date;
  minutesUntil: number;
  isDelayed: boolean;
  platform?: string;
  isCancelled: boolean;
};

export async function fetchSites(): Promise<TransportSite[]> {
  const url = new URL(`${BASE_URL}/sites`);
  url.searchParams.set("expand", "true");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Sites fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Array<Record<string, unknown>>;
  return parseSitesResponse(data);
}

export async function fetchDepartures(siteId: string): Promise<Departure[]> {
  const url = new URL(`${BASE_URL}/sites/${siteId}/departures`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Departures fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseDeparturesResponse(data);
}

function parseSitesResponse(data: Array<Record<string, unknown>>): TransportSite[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((site) => {
    const id = site.id !== undefined ? String(site.id) : "";
    const name = typeof site.name === "string" ? site.name : "";
    const lat = typeof site.lat === "number" ? site.lat : undefined;
    const lon = typeof site.lon === "number" ? site.lon : undefined;
    const products = Array.isArray(site.products) ? site.products.map(String) : [];
    return {
      id,
      name,
      coord: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
      products,
    };
  });
}

function parseDeparturesResponse(data: unknown): Departure[] {
  const departuresData = (data as { departures?: Array<Record<string, unknown>> })?.departures;
  if (!Array.isArray(departuresData)) {
    return [];
  }

  const now = new Date();

  return departuresData
    .map((dep) => parseDeparture(dep, now))
    .filter((d): d is Departure => d !== null)
    .sort((a, b) => a.expectedTime.getTime() - b.expectedTime.getTime())
    .slice(0, 30);
}

function parseDeparture(raw: Record<string, unknown>, now: Date): Departure | null {
  try {
    const scheduledStr = raw.scheduled as string | undefined;
    if (!scheduledStr) return null;
    const expectedStr = (raw.expected as string | undefined) || scheduledStr;
    const scheduledTime = new Date(scheduledStr);
    const expectedTime = new Date(expectedStr);

    const minutesUntil = Math.round((expectedTime.getTime() - now.getTime()) / 60000);
    if (minutesUntil < -1) return null;

    const line = raw.line as Record<string, unknown> | undefined;
    const lineDesignation = typeof line?.designation === "string" ? line.designation : "";
    const transportMode = typeof line?.transport_mode === "string" ? line.transport_mode : "";
    const destination = typeof raw.destination === "string" ? raw.destination : "";

    const stopPoint = raw.stop_point as Record<string, unknown> | undefined;
    const platform = typeof stopPoint?.designation === "string" ? stopPoint.designation : undefined;

    const state = typeof raw.state === "string" ? raw.state.toUpperCase() : "";
    const isCancelled = state === "CANCELLED" || state === "REPLACED";
    const isDelayed = expectedTime.getTime() - scheduledTime.getTime() > 60000;

    return {
      type: mapTransportMode(transportMode),
      line: lineDesignation,
      destination,
      scheduledTime,
      expectedTime,
      minutesUntil: Math.max(0, minutesUntil),
      isDelayed,
      platform,
      isCancelled,
    };
  } catch {
    return null;
  }
}

function mapTransportMode(mode: string): Departure["type"] {
  const modeUpper = mode?.toUpperCase() || "";

  if (modeUpper === "METRO") {
    return "metro";
  }
  if (modeUpper === "TRAIN" || modeUpper === "COMMUTER_TRAIN") {
    return "train";
  }
  if (modeUpper === "TRAM") {
    return "tram";
  }
  if (modeUpper === "SHIP" || modeUpper === "FERRY") {
    return "ship";
  }
  return "bus";
}
