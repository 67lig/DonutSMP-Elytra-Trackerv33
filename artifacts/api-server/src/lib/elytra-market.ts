import { createHash } from "node:crypto";
import https from "node:https";
import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  elytraListingsTable,
  elytraTransactionsTable,
  marketAlertsTable,
  priceObservationsTable,
} from "@workspace/db";
import { logger } from "./logger";

export const ELYTRA_CATEGORIES = [
  "elytra",
] as const;
export type ElytraCategory = (typeof ELYTRA_CATEGORIES)[number];

type RawRecord = Record<string, unknown>;

type NormalizedListing = {
  id: string;
  itemId: string | null;
  displayName: string;
  category: ElytraCategory;
  enchantments: string[];
  price: number;
  seller: string;
  sellerUuid: string | null;
  quantity: number;
  timeRemaining: string | null;
  collectedAt: Date;
};

export type MarketAnalysisContext = {
  pageOneListings: NormalizedListing[];
  pageTwoListings: NormalizedListing[];
  hourlyHistory: Awaited<ReturnType<ElytraMarketService["getHistory"]>>;
  historyRange: HistoryRange;
  marketContext: {
    lowest: number | null;
    median: number | null;
    average: number | null;
    priceChange: number | null;
    activeListings: number;
    activeUnits: number;
    recentPrices: number[];
  };
};

export type HistoryRange =
  | "five_minutes"
  | "hour"
  | "today"
  | "seven_days"
  | "thirty_days"
  | "ninety_days"
  | "one_year"
  | "all_time";

type ApiState = {
  connected: boolean;
  lastUpdated: Date | null;
  message: string;
};

const MAX_AUCTION_PAGES = 20;
const POLL_INTERVAL_MS = 10_000;
const ROLLING_REQUEST_LIMIT = 220;
const REQUEST_WINDOW_MS = 60_000;

type ScheduledRequest = {
  page: number;
  sequence: number;
};

type FetchListingsResult = {
  listings: NormalizedListing[];
  pagesScanned: number;
  complete: boolean;
};

function requestAuctionPage(page: number, apiKey: string): Promise<unknown> {
  const body = JSON.stringify({
    search: "elytra",
    sort: "lowest_price",
  });

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "api.donutsmp.net",
      path: `/v1/auction/list/${page}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`DonutSMP returned HTTP ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("DonutSMP returned invalid JSON"));
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function nestedValue(record: RawRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const cleaned = value.replace(/[$,]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function extractRows(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) return payload.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });

  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["data", "result", "auctions", "items", "results", "listings"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate.flatMap((item) => {
        const nested = asRecord(item);
        return nested ? [nested] : [];
      });
    }
  }
  return [];
}

function extractEnchantments(record: RawRecord): string[] {
  const item = asRecord(record.item) ?? asRecord(record.item_data) ?? {};
  const source = nestedValue(record, ["enchantments", "enchants"]) ??
    nestedValue(item, ["enchantments", "enchants"]);
  const collect = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap((entry) => {
      if (typeof entry === "string") return [entry.trim()];
      const enchantment = asRecord(entry);
      if (!enchantment) return [];
      const name = asString(nestedValue(enchantment, ["name", "id", "type"]));
      const level = asNumber(nestedValue(enchantment, ["level", "lvl"]));
      if (!name) return [];
      return [level ? `${name} ${Math.floor(level)}` : name];
    });
    const object = asRecord(value);
    if (!object) return [];
    const nested = nestedValue(object, ["levels", "enchantments"]);
    if (nested !== undefined) return collect(nested);
    return Object.entries(object).flatMap(([name, level]) => {
      const numericLevel = asNumber(level);
      if (numericLevel !== null) return [numericLevel ? `${name} ${Math.floor(numericLevel)}` : name];
      return [];
    });
  };
  return collect(source);
}

function isElytra(record: RawRecord): boolean {
  const item = asRecord(record.item) ?? asRecord(record.item_data) ?? {};
  const itemId = asString(nestedValue(item, ["id", "item_id", "itemId"]))?.toLowerCase();
  if (itemId) return itemId === "elytra" || itemId.endsWith(":elytra");
  const recordItemId = asString(nestedValue(record, ["item_id", "itemId"]))?.toLowerCase();
  if (recordItemId) return recordItemId === "elytra" || recordItemId.endsWith(":elytra");
  const searchable = [
    ...["display_name", "displayName", "name", "material", "type", "item_id", "itemId"].map((key) => record[key]),
    ...["display_name", "displayName", "name", "material", "type", "id"].map((key) => item[key]),
  ]
    .map(asString)
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return searchable.includes("elytra");
}

function formatTimeRemaining(value: unknown): string | null {
  const text = asString(value);
  if (text) return text;
  const rawDuration = asNumber(value);
  if (rawDuration === null || rawDuration < 0) return null;
  const seconds = rawDuration > 604_800 ? rawDuration / 1_000 : rawDuration;
  const wholeSeconds = Math.floor(seconds);
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function buildPollPlan(): ScheduledRequest[] {
  return Array.from({ length: MAX_AUCTION_PAGES }, (_, index) => ({
    page: index + 1,
    sequence: index,
  }));
}

function normalizeListing(record: RawRecord, collectedAt: Date): NormalizedListing | null {
  if (!isElytra(record)) return null;
  const item = asRecord(record.item) ?? asRecord(record.item_data) ?? {};
  const enchantments = extractEnchantments(record);
  const price = asNumber(nestedValue(record, ["price", "cost", "amount", "starting_price", "bid"]) ??
    nestedValue(item, ["price", "cost"]));
  if (price === null || price < 0) return null;

  const displayName = asString(nestedValue(record, ["display_name", "displayName", "name"]) ??
    nestedValue(item, ["display_name", "displayName", "name"])) ?? "Elytra";
  const sellerRecord = asRecord(record.seller) ?? asRecord(record.owner);
  const seller = asString(nestedValue(record, ["seller_name", "sellerName", "username"])) ??
    asString(nestedValue(sellerRecord ?? {}, ["name", "username"])) ?? "Unknown seller";
  const sellerUuid = asString(nestedValue(record, ["seller_uuid", "sellerUuid", "owner_uuid"])) ??
    asString(nestedValue(sellerRecord ?? {}, ["uuid", "id"]));
  const quantity = Math.max(1, Math.floor(asNumber(nestedValue(record, ["quantity", "count", "amount"])) ?? 1));
  const itemId = asString(nestedValue(record, ["item_id", "itemId", "auction_id", "auctionId"]) ??
    nestedValue(item, ["id", "item_id", "itemId"]));
  const rawId = asString(nestedValue(record, ["id", "auction_id", "auctionId", "uuid"])) ??
    `${seller}|${price}|${quantity}|${displayName}|${enchantments.join(",")}`;
  const id = createHash("sha1").update(rawId).digest("hex").slice(0, 32);

  return {
    id,
    itemId,
    displayName,
    category: "elytra",
    enchantments,
    price,
    seller,
    sellerUuid,
    quantity,
    timeRemaining: formatTimeRemaining(nestedValue(record, [
      "time_remaining",
      "timeRemaining",
      "time_left",
      "timeLeft",
      "expires_in",
      "expiresIn",
    ])),
    collectedAt,
  };
}

class RollingRequestManager {
  private requestTimes: number[] = [];
  private readonly active = new Map<string, Promise<unknown>>();

  private prune(now = Date.now()): void {
    this.requestTimes = this.requestTimes.filter((time) => now - time < REQUEST_WINDOW_MS);
  }

  private async waitForSlot(): Promise<void> {
    this.prune();
    if (this.requestTimes.length < ROLLING_REQUEST_LIMIT) return;
    const waitMs = Math.max(250, this.requestTimes[0] + REQUEST_WINDOW_MS - Date.now() + 25);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.waitForSlot();
  }

  request<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      await this.waitForSlot();
      this.requestTimes.push(Date.now());
      return task();
    })();
    this.active.set(key, promise);
    void promise.then(
      () => this.active.delete(key),
      () => this.active.delete(key),
    );
    return promise;
  }

  usage(): number {
    this.prune();
    return this.requestTimes.length;
  }
}

export class ElytraMarketService {
  private readonly requestManager = new RollingRequestManager();
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pollCycle = 0;
  private state: ApiState = {
    connected: false,
    lastUpdated: null,
    message: "Connecting to DonutSMP auction feed",
  };

  start(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  getApiStatus(): ApiState & { requestsInWindow: number; requestLimit: number } {
    return {
      ...this.state,
      requestsInWindow: this.requestManager.usage(),
      requestLimit: ROLLING_REQUEST_LIMIT,
    };
  }

  private async fetchPage(page: number, requestKey: string): Promise<unknown> {
    const apiKey = process.env.DONUTSMP_API_KEY;
    if (!apiKey) throw new Error("DONUTSMP_API_KEY is not configured");
    const response = await this.requestManager.request(requestKey, () =>
      requestAuctionPage(page, apiKey),
    );
    return response;
  }

  private async fetchListings(
    onPageOneReady?: (listings: NormalizedListing[]) => void,
  ): Promise<FetchListingsResult> {
    const payloads = new Map<number, { sequence: number; payload: unknown }>();
    const failedPages = new Map<number, string>();
    const plan = buildPollPlan();
    const cycle = this.pollCycle;
    this.pollCycle += 1;
    const collectedAt = new Date();
    let pageOneReported = false;

    await Promise.all(plan.map(async (request) => {
      try {
        const payload = await this.fetchPage(
          request.page,
          `auction:cycle:${cycle}:${request.sequence}`,
        );
        const previous = payloads.get(request.page);
        if (!previous || request.sequence > previous.sequence) {
          payloads.set(request.page, { sequence: request.sequence, payload });
        }
        if (request.page === 1 && !pageOneReported) {
          pageOneReported = true;
          const pageOneListings = extractRows(payload)
            .map((row) => normalizeListing(row, collectedAt))
            .filter((listing): listing is NormalizedListing => listing !== null);
          onPageOneReady?.(pageOneListings);
        }
      } catch (error) {
        failedPages.set(request.page, error instanceof Error ? error.message : "Unknown page request error");
        logger.debug({ err: error, page: request.page }, "DonutSMP auction request failed");
      }
    }));

    const seen = new Map<string, NormalizedListing>();
    for (const [page, { payload }] of payloads.entries()) {
      for (const row of extractRows(payload)) {
        const listing = normalizeListing(row, collectedAt);
        if (listing) {
          seen.set(listing.id, listing);
        }
      }
    }
    const lastSuccessfulPage = Math.max(...payloads.keys(), 0);
    const hasNonTailFailure = [...failedPages.entries()].some(([page, message]) => {
      const isOutOfRange = message.includes("HTTP 400") || message.includes("HTTP 404");
      return page <= lastSuccessfulPage || !isOutOfRange;
    });
    return {
      listings: [...seen.values()],
      pagesScanned: payloads.size,
      complete: payloads.has(1) && !hasNonTailFailure,
    };
  }

  private async recordMarket(listings: NormalizedListing[]): Promise<void> {
    const previousListings = await db.select().from(elytraListingsTable);
    const previousIds = new Set(previousListings.map((listing) => listing.id));
    const previousByCategory = new Map<ElytraCategory, NormalizedListing[]>();
    const currentByCategory = new Map<ElytraCategory, NormalizedListing[]>();
    for (const category of ELYTRA_CATEGORIES) {
      previousByCategory.set(category, previousListings.filter((listing) => listing.category === category) as NormalizedListing[]);
      currentByCategory.set(category, listings.filter((listing) => listing.category === category));
    }

    await db.transaction(async (tx) => {
      await tx.delete(elytraListingsTable);
      if (listings.length) await tx.insert(elytraListingsTable).values(listings);
      const newListings = listings.filter((listing) => !previousIds.has(listing.id));
      if (newListings.length) {
        await tx.insert(elytraTransactionsTable).values(
          newListings.map((listing) => ({
            id: listing.id,
            seller: listing.seller,
            price: listing.price,
            category: listing.category,
            enchantments: listing.enchantments,
            quantity: listing.quantity,
            timestamp: listing.collectedAt,
          })),
        ).onConflictDoNothing();
      }
    });

    for (const category of ELYTRA_CATEGORIES) {
      const current = currentByCategory.get(category) ?? [];
      if (!current.length) continue;
      const prices = current.map((listing) => listing.price).sort((a, b) => a - b);
      const lowest = prices[0];
      const median = prices.length % 2
        ? prices[Math.floor(prices.length / 2)]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
      const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      const [lastObservation] = await db.select().from(priceObservationsTable)
        .where(eq(priceObservationsTable.category, category))
        .orderBy(desc(priceObservationsTable.timestamp))
        .limit(1);
       const priceChange = lastObservation?.price
         ? ((lowest - lastObservation.price) / lastObservation.price) * 100
        : null;
       const shouldRecord = !lastObservation ||
         Date.now() - lastObservation.timestamp.getTime() >= POLL_INTERVAL_MS;
      if (shouldRecord) {
        await db.insert(priceObservationsTable).values({
          category,
          timestamp: new Date(),
          price: lowest,
          priceChange,
          sampleSize: current.length,
        });
      }

      const previous = previousByCategory.get(category) ?? [];
      if (!previous.length) continue;
      const previousQuantity = previous.reduce((sum, listing) => sum + listing.quantity, 0);
      const currentQuantity = current.reduce((sum, listing) => sum + listing.quantity, 0);
      const quantityDelta = currentQuantity - previousQuantity;
      const boughtQuantity = Math.max(0, -quantityDelta);
      const soldQuantity = Math.max(0, quantityDelta);
       const massiveBuy = boughtQuantity >= 1;
       const massiveSell = soldQuantity >= 1;
      if (massiveBuy || massiveSell) {
        const type = massiveBuy ? "massive_buy" : "massive_sell";
        const affectedQuantity = massiveBuy ? boughtQuantity : soldQuantity;
        const [recentAlert] = await db.select().from(marketAlertsTable)
          .where(eq(marketAlertsTable.category, category))
          .orderBy(desc(marketAlertsTable.detectedAt))
          .limit(1);
        const recentlyDetected = recentAlert && Date.now() - recentAlert.detectedAt.getTime() < 900_000;
        if (!recentlyDetected) {
          await db.insert(marketAlertsTable).values({
            type,
            category,
            affectedQuantity,
            previousPrice: lastObservation?.price ?? null,
            currentPrice: lowest,
            percentageChange: priceChange,
            estimatedValue: lowest * affectedQuantity,
            detectedAt: new Date(),
          });
        }
      }
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const result = await this.fetchListings((pageOneListings) => {
          this.state = {
            connected: true,
            lastUpdated: new Date(),
            message: pageOneListings.length
              ? "Live DonutSMP auction polling"
              : "Connected to DonutSMP auction feed",
          };
        });
        if (result.complete) {
          await this.recordMarket(result.listings);
          this.state = {
            connected: true,
            lastUpdated: new Date(),
            message: result.listings.length
              ? `Live DonutSMP auction data · scanned ${result.pagesScanned} pages`
              : `Connected, but no direct Elytra listings were found across ${result.pagesScanned} pages`,
          };
          logger.info({
            qualifyingListings: result.listings.length,
            qualifyingUnits: result.listings.reduce((sum, listing) => sum + listing.quantity, 0),
            pagesScanned: result.pagesScanned,
            scanIntervalMs: POLL_INTERVAL_MS,
          }, "DonutSMP Elytra market full scan refreshed");
        } else {
          this.state = {
            connected: false,
            lastUpdated: this.state.lastUpdated,
            message: `Partial Auction House scan (${result.pagesScanned}/${MAX_AUCTION_PAGES} pages); keeping the last complete snapshot`,
          };
          logger.warn({
            pagesScanned: result.pagesScanned,
            expectedPages: MAX_AUCTION_PAGES,
            failedPages: Object.fromEntries(failedPages),
          }, "DonutSMP Elytra market scan incomplete");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown DonutSMP error";
        this.state = {
          connected: false,
          lastUpdated: this.state.lastUpdated,
          message: message.includes("HTTP 401")
            ? "Unauthorized: check DONUTSMP_API_KEY"
            : message,
        };
        logger.warn({ err: error }, "DonutSMP market refresh failed");
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  async getDashboard() {
    const listings = (await db.select().from(elytraListingsTable))
      .filter((listing) => listing.category === ELYTRA_CATEGORIES[0]);
    const stats = ELYTRA_CATEGORIES.map((category) => {
      const categoryListings = listings.filter((listing) => listing.category === category);
      const prices = categoryListings
        .map((listing) => listing.price)
        .sort((a, b) => a - b);
      const median = prices.length % 2
        ? prices[Math.floor(prices.length / 2)]
        : prices.length ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2 : null;
      return {
        category,
        lowest: prices[0] ?? null,
        highest: prices.at(-1) ?? null,
        average: prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null,
        median,
        activeListings: prices.length,
        activeUnits: categoryListings.reduce((sum, listing) => sum + listing.quantity, 0),
        priceChange: null,
        currency: "coins",
      };
    });
    const statsWithChange = await Promise.all(stats.map(async (stat) => {
      const [latest] = await db.select().from(priceObservationsTable)
        .where(eq(priceObservationsTable.category, stat.category))
        .orderBy(desc(priceObservationsTable.timestamp))
        .limit(1);
      return { ...stat, priceChange: latest?.priceChange ?? null };
    }));
    return {
      stats: statsWithChange,
      api: this.getApiStatus(),
      qualifyingListings: listings.length,
      qualifyingUnits: listings.reduce((sum, listing) => sum + listing.quantity, 0),
      generatedAt: new Date(),
    };
  }

  async getHistory(category?: ElytraCategory, range: HistoryRange = "thirty_days") {
    const cutoff = new Date();
    const duration = range === "five_minutes" ? 300_000 :
      range === "hour" ? 3_600_000 :
      range === "today" ? 86_400_000 :
        range === "seven_days" ? 604_800_000 :
          range === "thirty_days" ? 2_592_000_000 :
            range === "ninety_days" ? 7_776_000_000 :
              range === "one_year" ? 31_536_000_000 : 0;
    if (duration > 0) cutoff.setTime(cutoff.getTime() - duration);
    const observationRows = await db.select().from(priceObservationsTable)
      .orderBy(asc(priceObservationsTable.timestamp));
    const snapshots = observationRows
      .filter((row) => row.category === ELYTRA_CATEGORIES[0] &&
        row.timestamp >= cutoff && (!category || row.category === category))
      .map((row) => ({
        timestamp: row.timestamp,
        price: row.price,
        high: row.price,
        low: row.price,
        sampleSize: row.sampleSize,
      }));
    const source = snapshots;
    if (!source.length) return [];

    const requestedBucketMs = range === "five_minutes" ? 15_000 :
      range === "today" ? 60 * 60_000 :
        range === "seven_days" ? 6 * 60 * 60_000 :
          range === "thirty_days" ? 12 * 60 * 60_000 :
            range === "ninety_days" ? 24 * 60 * 60_000 :
              range === "one_year" ? 7 * 86_400_000 : 30 * 86_400_000;
    const timeSpan = source[source.length - 1].timestamp.getTime() - source[0].timestamp.getTime();
    const bucketMs = timeSpan > requestedBucketMs ? requestedBucketMs : 0;
    const buckets = new Map<number, typeof source>();
    for (const point of source) {
      const timestamp = point.timestamp.getTime();
      const bucketKey = bucketMs ? Math.floor(timestamp / bucketMs) * bucketMs : timestamp;
      const bucket = buckets.get(bucketKey) ?? [];
      bucket.push(point);
      buckets.set(bucketKey, bucket);
    }

    let previousClose: number | null = null;
    return [...buckets.entries()].sort(([left], [right]) => left - right).map(([bucketKey, bucket], index) => {
      const prices = bucket.map((point) => point.price);
      const open = prices[0];
      const close = prices[prices.length - 1];
      const high = Math.max(...bucket.map((point) => point.high));
      const low = Math.min(...bucket.map((point) => point.low));
      const priceChange = previousClose == null
        ? null
        : ((close - previousClose) / previousClose) * 100;
      previousClose = close;
      return {
        id: index + 1,
        category: ELYTRA_CATEGORIES[0],
        timestamp: new Date(bucketMs ? bucketKey : bucket[0].timestamp),
        price: close,
        open,
        high,
        low,
        close,
        priceChange,
        sampleSize: bucket.reduce((sum, point) => sum + point.sampleSize, 0),
        observationCount: bucket.length,
      };
    });
  }

  async getListings(category?: ElytraCategory, sort = "lowest") {
    const rows = await db.select().from(elytraListingsTable);
    const filtered = rows.filter((row) =>
      row.category === ELYTRA_CATEGORIES[0] && (!category || row.category === category),
    );
    return [...filtered].sort((a, b) => sort === "highest"
      ? b.price - a.price
      : sort === "recent"
        ? b.collectedAt.getTime() - a.collectedAt.getTime()
        : a.price - b.price);
  }

  async getListingAnalysisContext(listingId: string) {
    const [listing] = await db.select().from(elytraListingsTable)
      .where(eq(elytraListingsTable.id, listingId))
      .limit(1);
    if (!listing) return null;

    const [latestObservation, observations, allListings] = await Promise.all([
      db.select().from(priceObservationsTable)
        .where(eq(priceObservationsTable.category, listing.category))
        .orderBy(desc(priceObservationsTable.timestamp))
        .limit(1),
      db.select().from(priceObservationsTable)
        .where(eq(priceObservationsTable.category, listing.category))
        .orderBy(desc(priceObservationsTable.timestamp))
        .limit(12),
      db.select().from(elytraListingsTable)
        .where(eq(elytraListingsTable.category, listing.category)),
    ]);
    const prices = allListings.map((row) => row.price).sort((a, b) => a - b);
    const median = prices.length % 2
      ? prices[Math.floor(prices.length / 2)]
      : prices.length ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2 : null;
    const average = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null;

    return {
      listing: { ...listing, category: "elytra" as const },
      marketContext: {
        lowest: prices[0] ?? null,
        median,
        average,
        priceChange: latestObservation[0]?.priceChange ?? null,
        activeListings: prices.length,
        activeUnits: allListings.reduce((sum, row) => sum + row.quantity, 0),
        recentPrices: observations.reverse().map((row) => row.price),
      },
    };
  }

  async getMarketAnalysisContext(range: HistoryRange = "hour"): Promise<MarketAnalysisContext> {
    const [pageOnePayload, pageTwoPayload, selectedHistory, currentListings] = await Promise.all([
      this.fetchPage(1, "auction:analysis:page:1"),
      this.fetchPage(2, "auction:analysis:page:2"),
      this.getHistory(ELYTRA_CATEGORIES[0], range),
      db.select().from(elytraListingsTable)
        .where(eq(elytraListingsTable.category, ELYTRA_CATEGORIES[0])),
    ]);
    const normalizePage = (payload: unknown) => extractRows(payload)
      .map((row) => normalizeListing(row, new Date()))
      .filter((listing): listing is NormalizedListing => listing !== null);
    const prices = currentListings.map((listing) => listing.price).sort((left, right) => left - right);
    const median = prices.length % 2
      ? prices[Math.floor(prices.length / 2)]
      : prices.length ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2 : null;
    const average = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null;
    const activeUnits = currentListings.reduce((sum, listing) => sum + listing.quantity, 0);
    return {
      pageOneListings: normalizePage(pageOnePayload),
      pageTwoListings: normalizePage(pageTwoPayload),
      hourlyHistory: selectedHistory,
      historyRange: range,
      marketContext: {
        lowest: prices[0] ?? null,
        median,
        average,
        priceChange: selectedHistory.at(-1)?.priceChange ?? null,
        activeListings: prices.length,
        activeUnits,
        recentPrices: selectedHistory.map((point) => point.close),
      },
    };
  }

  async getTransactions(category?: ElytraCategory) {
    const rows = await db.select().from(elytraTransactionsTable)
      .orderBy(desc(elytraTransactionsTable.timestamp))
      .limit(50);
    return rows.filter((row) =>
      row.category === ELYTRA_CATEGORIES[0] && (!category || row.category === category),
    );
  }

  async getAlerts(limit = 10, threshold = 10) {
    const rows = await db.select().from(marketAlertsTable)
      .orderBy(desc(marketAlertsTable.detectedAt))
      .limit(Math.max(limit, 50));
    return rows.filter((row) =>
      row.category === ELYTRA_CATEGORIES[0] &&
      row.affectedQuantity >= threshold &&
      (row.type === "massive_buy" || row.type === "massive_sell"),
    ).slice(0, limit);
  }
}

export const elytraMarketService = new ElytraMarketService();