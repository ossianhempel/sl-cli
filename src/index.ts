#!/usr/bin/env node
import { Command } from "commander";
import { fetchTrips, resolveLocation, TripEndpointLocation, TripProposal } from "./api/journeyPlanner.js";
import { fetchDepartures, fetchSites, Departure, TransportSite } from "./api/transport.js";
import { CONFIG_KEYS, readConfig, resolveOrigin, writeConfig } from "./config.js";

const program = new Command();

program
  .name("sl-clie")
  .description("Plan SL journeys and query departures")
  .option("--json", "output JSON")
  .option("--plain", "output line-based text")
  .option("-q, --quiet", "suppress non-essential output")
  .option("-v, --verbose", "enable verbose logging")
  .option("--no-color", "disable color output")
  .version("0.1.0");

program
  .command("plan")
  .description("Plan a trip")
  .requiredOption("--to <place>", "destination (stop, address, or lat,lon)")
  .option("--from <place>", "origin (stop, address, or lat,lon)")
  .option("--depart <datetime>", "depart at (YYYY-MM-DD HH:mm, ISO, or HH:mm)")
  .option("--arrive <datetime>", "arrive by (YYYY-MM-DD HH:mm, ISO, or HH:mm)")
  .option("--at <datetime>", "alias for --depart")
  .option("--trips <number>", "number of trips (1-3)", parseNumber)
  .option("--optimize <mode>", "time|changes|walk")
  .option("--max-changes <number>", "maximum number of changes", parseNumber)
  .action(async (opts, command) => {
    const merged = collectOpts(command);
    const mode = resolveOutputMode(merged);

    try {
      const fromValue = resolveOrigin(opts.from);
      if (!fromValue) {
        throw new Error("Missing origin. Provide --from or set config origin.");
      }

      const toValue = opts.to?.trim();
      if (!toValue) {
        throw new Error("Missing destination (--to).");
      }

      const departValue = opts.depart || opts.at;
      const arriveValue = opts.arrive;

      if (departValue && arriveValue) {
        throw new Error("Use either --depart/--at or --arrive, not both.");
      }

      const parsedDateTime = departValue
        ? parseDateTimeInput(departValue)
        : arriveValue
        ? parseDateTimeInput(arriveValue)
        : undefined;

      if ((departValue || arriveValue) && !parsedDateTime) {
        throw new Error("Invalid date/time format.");
      }
      const dateTime = parsedDateTime ?? undefined;

      const originResolved = await resolveLocationInput(fromValue);
      const destinationResolved = await resolveLocationInput(toValue);

      if (!originResolved.location || !destinationResolved.location) {
        throw new Error("Failed to resolve origin or destination.");
      }

      const options = {
        numTrips: opts.trips ?? 3,
        dateTime: dateTime ?? undefined,
        dateTimeMode: arriveValue ? "arr" : "dep",
        routeType: mapOptimizeToRouteType(opts.optimize),
        maxChanges: typeof opts.maxChanges === "number" ? opts.maxChanges : undefined,
      } as const;

      const trips = await fetchTrips(
        originResolved.location,
        destinationResolved.location,
        options
      );

      const output = buildTripsOutput(
        trips,
        originResolved.meta,
        destinationResolved.meta,
        dateTime,
        arriveValue ? "arr" : departValue ? "dep" : "none"
      );

      printTrips(output, mode);
    } catch (error) {
      handleError(error, mode);
    }
  });

program
  .command("next")
  .description("Show upcoming departures from a stop")
  .option("--stop <nameOrId>", "stop name or siteId")
  .option("--near <lat,lon>", "use nearest stop to coordinates")
  .option("--minutes <number>", "limit to departures within N minutes", parseNumber)
  .action(async (opts, command) => {
    const merged = collectOpts(command);
    const mode = resolveOutputMode(merged);

    try {
      if (!opts.stop && !opts.near) {
        throw new Error("Provide --stop or --near.");
      }

      const site = await resolveSite(opts.stop, opts.near);
      if (!site) {
        throw new Error("Unable to resolve stop.");
      }

      const departures = await fetchDepartures(site.id);
      const maxMinutes = typeof opts.minutes === "number" ? opts.minutes : undefined;
      const filtered = maxMinutes
        ? departures.filter((d) => d.minutesUntil <= maxMinutes)
        : departures;

      printDepartures(site, filtered, mode);
    } catch (error) {
      handleError(error, mode);
    }
  });

const config = program.command("config").description("Manage config");

config
  .command("list")
  .description("List config values")
  .action((_opts, command) => {
    const merged = collectOpts(command);
    const mode = resolveOutputMode(merged);
    const cfg = readConfig();

    if (mode === "json") {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }

    const lines = CONFIG_KEYS.map((key) => `${key}=${cfg[key] ?? ""}`);
    console.log(lines.join("\n"));
  });

config
  .command("get")
  .description("Get a config value")
  .argument("<key>")
  .action((key: string, _opts, command) => {
    const merged = collectOpts(command);
    const mode = resolveOutputMode(merged);
    assertConfigKey(key);

    const cfg = readConfig();
    const value = cfg[key as keyof typeof cfg];

    if (mode === "json") {
      console.log(JSON.stringify({ key, value: value ?? null }, null, 2));
      return;
    }

    console.log(value ?? "");
  });

config
  .command("set")
  .description("Set a config value")
  .argument("<key>")
  .argument("<value>")
  .action((key: string, value: string, _opts, command) => {
    const merged = collectOpts(command);
    const mode = resolveOutputMode(merged);
    assertConfigKey(key);

    const cfg = readConfig();
    cfg[key as keyof typeof cfg] = value;
    writeConfig(cfg);

    if (mode === "json") {
      console.log(JSON.stringify({ key, value }, null, 2));
      return;
    }

    console.log(`${key}=${value}`);
  });

program.parseAsync(process.argv).catch((error) => {
  handleError(error, resolveOutputMode(program.opts()));
});

function collectOpts(command: Command): Record<string, unknown> {
  const parentOpts = command.parent ? command.parent.opts() : {};
  return { ...parentOpts, ...command.opts() } as Record<string, unknown>;
}

type OutputMode = "json" | "plain" | "pretty";

function resolveOutputMode(opts: Record<string, unknown>): OutputMode {
  const json = Boolean(opts.json);
  const plain = Boolean(opts.plain);

  if (json && plain) {
    throw new Error("Use either --json or --plain, not both.");
  }

  if (json) return "json";
  if (plain) return "plain";
  if (process.stdout.isTTY) return "pretty";
  return "json";
}

function handleError(error: unknown, mode: OutputMode): void {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (mode === "json") {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parseDateTimeInput(input: string): Date | null {
  const trimmed = input.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  const dateTimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
  if (dateTimeMatch) {
    const [year, month, day] = dateTimeMatch[1].split("-").map(Number);
    const [hour, minute] = dateTimeMatch[2].split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    const [hour, minute] = trimmed.split(":").map(Number);
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

type ResolvedLocationMeta = {
  query: string;
  type: "stop" | "address" | "coord";
  id?: string;
  label?: string;
  coord?: { lat: number; lon: number };
};

type ResolvedLocation = {
  location: TripEndpointLocation | null;
  meta: ResolvedLocationMeta;
};

async function resolveLocationInput(input: string): Promise<ResolvedLocation> {
  const coord = parseCoordInput(input);
  if (coord) {
    return {
      location: { kind: "coord", lat: coord.lat, lon: coord.lon },
      meta: {
        query: input,
        type: "coord",
        coord,
      },
    };
  }

  const resolved = await resolveLocation(input);
  if (!resolved) {
    return {
      location: null,
      meta: { query: input, type: "stop" },
    };
  }

  return {
    location: { kind: "id", id: resolved.id, label: resolved.label, coord: resolved.coord },
    meta: {
      query: input,
      type: resolved.type,
      id: resolved.id,
      label: resolved.label,
      coord: resolved.coord,
    },
  };
}

function parseCoordInput(input: string): { lat: number; lon: number } | null {
  const match = input.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

function mapOptimizeToRouteType(value?: string):
  | "leasttime"
  | "leastinterchange"
  | "leastwalking"
  | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "time") return "leasttime";
  if (normalized === "changes") return "leastinterchange";
  if (normalized === "walk") return "leastwalking";
  return undefined;
}

function buildTripsOutput(
  trips: TripProposal[],
  origin: ResolvedLocationMeta,
  destination: ResolvedLocationMeta,
  dateTime: Date | undefined,
  dateTimeMode: "dep" | "arr" | "none"
) {
  const tripData = trips.map((trip) => {
    const transportLegs = trip.legs.filter((leg) => leg.type !== "walk");
    const changes = Math.max(0, transportLegs.length - 1);

    return {
      departureTime: trip.departureTime.toISOString(),
      arrivalTime: trip.arrivalTime.toISOString(),
      durationMinutes: trip.durationMinutes,
      changes,
      summary: trip.routeSummary,
      legs: trip.legs.map((leg) => ({
        type: leg.type,
        line: leg.line ?? null,
        direction: leg.direction ?? null,
        departureTime: leg.departureTime.toISOString(),
        arrivalTime: leg.arrivalTime.toISOString(),
        durationMinutes: Math.max(0, Math.round(leg.durationSeconds / 60)),
        origin: leg.originName,
        destination: leg.destinationName,
        platform: leg.platform ?? null,
      })),
    };
  });

  return {
    origin,
    destination,
    dateTime: dateTime ? dateTime.toISOString() : null,
    dateTimeMode,
    trips: tripData,
  };
}

function printTrips(output: ReturnType<typeof buildTripsOutput>, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (mode === "plain") {
    const lines = output.trips.map((trip, index) => {
      return [
        "trip",
        String(index + 1),
        `dep=${trip.departureTime}`,
        `arr=${trip.arrivalTime}`,
        `dur=${trip.durationMinutes}m`,
        `changes=${trip.changes}`,
        `summary=${trip.summary}`,
      ].join("\t");
    });
    console.log(lines.join("\n"));
    return;
  }

  const header = `From: ${formatLocationLabel(output.origin)} -> ${formatLocationLabel(
    output.destination
  )}`;
  console.log(header);
  if (output.dateTime && output.dateTimeMode !== "none") {
    const modeLabel = output.dateTimeMode === "arr" ? "Arrive" : "Depart";
    console.log(`${modeLabel}: ${formatLocalDateTime(new Date(output.dateTime))}`);
  }

  output.trips.forEach((trip, index) => {
    const transportLegs = trip.legs.filter((leg) => leg.type !== "walk");
    const changes = Math.max(0, transportLegs.length - 1);
    console.log(
      `Trip ${index + 1}: ${formatLocalTime(new Date(trip.departureTime))} -> ${formatLocalTime(
        new Date(trip.arrivalTime)
      )} (${trip.durationMinutes} min, ${changes} changes)`
    );

    trip.legs.forEach((leg) => {
      const line = leg.line ? ` ${leg.line}` : "";
      const direction = leg.direction ? ` toward ${leg.direction}` : "";
      const platform = leg.platform ? ` platform ${leg.platform}` : "";
      const dep = formatLocalTime(new Date(leg.departureTime));
      const arr = formatLocalTime(new Date(leg.arrivalTime));
      console.log(
        `  ${leg.type}${line}${direction}: ${leg.origin} -> ${leg.destination} ${dep}-${arr}${platform}`
      );
    });
  });
}

function formatLocationLabel(location: ResolvedLocationMeta): string {
  if (location.label) return location.label;
  if (location.coord) return `${location.coord.lat},${location.coord.lon}`;
  return location.query;
}

function formatLocalTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatLocalDateTime(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${formatLocalTime(date)}`;
}

async function resolveSite(stopInput?: string, nearInput?: string): Promise<TransportSite | null> {
  const sites = await fetchSites();
  if (nearInput) {
    const coord = parseCoordInput(nearInput);
    if (!coord) {
      throw new Error("Invalid --near coordinates. Use lat,lon.");
    }
    return findNearestSite(sites, coord.lat, coord.lon);
  }

  if (!stopInput) {
    return null;
  }

  const trimmed = stopInput.trim();
  if (/^\d+$/.test(trimmed)) {
    const match = sites.find((site) => site.id === trimmed);
    if (match) return match;
    return { id: trimmed, name: trimmed, products: [] };
  }

  const normalizedQuery = trimmed.toLowerCase();
  const matches = sites.filter((site) => site.name.toLowerCase().includes(normalizedQuery));
  if (matches.length === 0) return null;

  const exact = matches.find((site) => site.name.toLowerCase() === normalizedQuery);
  if (exact) return exact;

  const prefix = matches.find((site) => site.name.toLowerCase().startsWith(normalizedQuery));
  if (prefix) return prefix;

  return matches[0];
}

function findNearestSite(sites: TransportSite[], lat: number, lon: number): TransportSite | null {
  let best: TransportSite | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const site of sites) {
    if (!site.coord) continue;
    const distance = haversineDistance(lat, lon, site.coord.lat, site.coord.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = site;
    }
  }

  return best;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function printDepartures(site: TransportSite, departures: Departure[], mode: OutputMode): void {
  if (mode === "json") {
    console.log(
      JSON.stringify(
        {
          site: {
            id: site.id,
            name: site.name,
          },
          departures: departures.map((dep) => ({
            type: dep.type,
            line: dep.line,
            destination: dep.destination,
            scheduledTime: dep.scheduledTime.toISOString(),
            expectedTime: dep.expectedTime.toISOString(),
            minutesUntil: dep.minutesUntil,
            isDelayed: dep.isDelayed,
            isCancelled: dep.isCancelled,
            platform: dep.platform ?? null,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  if (mode === "plain") {
    const lines = departures.map((dep) => {
      return [
        "dep",
        dep.type,
        dep.line,
        dep.destination,
        `scheduled=${dep.scheduledTime.toISOString()}`,
        `expected=${dep.expectedTime.toISOString()}`,
        `in=${dep.minutesUntil}m`,
        `platform=${dep.platform ?? ""}`,
        `cancelled=${dep.isCancelled}`,
      ].join("\t");
    });
    console.log(lines.join("\n"));
    return;
  }

  console.log(`Stop: ${site.name} (${site.id})`);
  departures.forEach((dep) => {
    const depTime = formatLocalTime(dep.expectedTime);
    const delay = dep.isDelayed ? " delayed" : "";
    const cancelled = dep.isCancelled ? " cancelled" : "";
    const platform = dep.platform ? ` platform ${dep.platform}` : "";
    console.log(
      `${depTime} ${dep.type} ${dep.line} to ${dep.destination} in ${dep.minutesUntil}m${platform}${delay}${cancelled}`
    );
  });
}

function assertConfigKey(key: string): void {
  if (!CONFIG_KEYS.includes(key as typeof CONFIG_KEYS[number])) {
    throw new Error(`Invalid config key. Use one of: ${CONFIG_KEYS.join(", ")}`);
  }
}
