import "dotenv/config";
import { MongoClient, type Db } from "mongodb";

export const DB_NAME = process.env.MONGODB_DB || "edmRoom";

// Collections
export const TRACKS = "tracks"; // the catalogue: generated clips, their text descriptions and Voyage embeddings
export const TAPS = "taps"; // one reaction per guest per play (unique), owned by the guest
export const DERIVED = "derived"; // everything built from taps: taste, crowd memory, decisions, venue cards, staff notes
export const CONSENTS = "consents"; // per guest, per venue: may this venue use my taste / add my taps to its crowd memory
export const PRESENCE = "presence"; // who is in which room right now (one room at a time)
export const SESSIONS = "sessions"; // "tonight only" sessions, tied to one venue, with an end time
export const PREFS = "prefs"; // "bored of this" records: which likes were superseded, by whom, when
export const PLAYS = "plays"; // what each room played, and when
export const TOMBSTONES = "tombstones"; // text-free receipts of "forget me"

export type VenueId = "copper" | "basement";
export const VENUE_IDS: VenueId[] = ["copper", "basement"];
export const VENUES: Record<VenueId, { name: string; short: string; view: string; login: "copper" | "basement"; note: string }> = {
  copper: {
    name: "Copper Bar",
    short: "Copper",
    view: "v_copper",
    login: "copper",
    note: "Saturdays build slowly: warm house until midnight, then afro and disco. Peak around 1am.",
  },
  basement: {
    name: "Basement Club",
    short: "Basement",
    view: "v_basement",
    login: "basement",
    note: "Low ceiling, big system. Techno and trance after 11pm; the floor empties below 125 BPM.",
  },
};
export const isVenue = (v: unknown): v is VenueId => v === "copper" || v === "basement";

export type Login = "app" | "copper" | "basement" | "discovery";
const ENV: Record<Login, [string, string]> = {
  app: ["APP_DB_USER", "APP_DB_PASSWORD"],
  copper: ["COPPER_DB_USER", "COPPER_DB_PASSWORD"],
  basement: ["BASEMENT_DB_USER", "BASEMENT_DB_PASSWORD"],
  discovery: ["DISCOVERY_DB_USER", "DISCOVERY_DB_PASSWORD"],
};
export const loginName = (who: Login) => process.env[ENV[who][0]] || who;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const clients: Partial<Record<Login, MongoClient>> = {};

export async function client(who: Login): Promise<MongoClient> {
  const existing = clients[who];
  if (existing) return existing;
  const u = need(ENV[who][0]);
  const p = need(ENV[who][1]);
  const uri = `mongodb+srv://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${need("MONGODB_HOST")}/?retryWrites=true&w=majority&appName=musory`;
  const c = new MongoClient(uri, { authSource: "admin", serverSelectionTimeoutMS: 10000, maxPoolSize: 30 });
  await c.connect();
  clients[who] = c;
  return c;
}

export async function db(who: Login = "app"): Promise<Db> {
  return (await client(who)).db(DB_NAME);
}

export async function closeAll(): Promise<void> {
  await Promise.all(Object.values(clients).map((c) => c?.close()));
}

/** Strip anything that looks like a credential from an error before it reaches a screen or log. */
export function redactError(e: unknown): { code?: number; codeName?: string; message: string } {
  const err = e as { code?: number; codeName?: string; message?: string };
  const message = String(err?.message ?? e).replace(/mongodb(\+srv)?:\/\/[^@\s]+@/g, "mongodb$1://<redacted>@");
  return { code: err?.code, codeName: err?.codeName, message };
}
