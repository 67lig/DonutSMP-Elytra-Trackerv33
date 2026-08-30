import type { ElytraListing } from "@workspace/api-zod";
import type { MarketAnalysisContext } from "./elytra-market";

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
export const GEMINI_ANALYSIS_LIMIT = 5;
const GEMINI_ANALYSIS_WINDOW_MS = 60 * 60 * 1_000;

let geminiAnalysisTimestamps: number[] = [];

export type ListingAnalysisContext = {
  listing: ElytraListing;
  marketContext: {
    lowest: number | null;
    median: number | null;
    average: number | null;
    priceChange: number | null;
    activeListings: number;
    recentPrices: number[];
  };
};

export function getGeminiUsage() {
  pruneGeminiAnalysisTimestamps();
  return {
    used: geminiAnalysisTimestamps.length,
    remaining: Math.max(0, GEMINI_ANALYSIS_LIMIT - geminiAnalysisTimestamps.length),
    limit: GEMINI_ANALYSIS_LIMIT,
  };
}

function pruneGeminiAnalysisTimestamps(now = Date.now()): void {
  geminiAnalysisTimestamps = geminiAnalysisTimestamps.filter(
    (timestamp) => now - timestamp < GEMINI_ANALYSIS_WINDOW_MS,
  );
}

function reserveGeminiAnalysis(): number | null {
  pruneGeminiAnalysisTimestamps();
  if (geminiAnalysisTimestamps.length >= GEMINI_ANALYSIS_LIMIT) return null;
  const timestamp = Date.now();
  geminiAnalysisTimestamps.push(timestamp);
  return timestamp;
}

function releaseGeminiAnalysis(timestamp: number): void {
  pruneGeminiAnalysisTimestamps();
  const index = geminiAnalysisTimestamps.indexOf(timestamp);
  if (index >= 0) geminiAnalysisTimestamps.splice(index, 1);
}

function parseModelJson(text: string): {
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;
  summary: string;
  reasons: string[];
  risks: string[];
} {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini returned invalid analysis JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Gemini returned an empty analysis");
  const record = parsed as Record<string, unknown>;
  const recommendation = record.recommendation;
  const confidence = record.confidence;
  const summary = record.summary;
  const reasons = record.reasons;
  const risks = record.risks;
  if (!["BUY", "SELL", "HOLD"].includes(String(recommendation)) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) ||
      typeof summary !== "string" ||
      !Array.isArray(reasons) || !reasons.every((reason) => typeof reason === "string") ||
      !Array.isArray(risks) || !risks.every((risk) => typeof risk === "string")) {
    throw new Error("Gemini returned an incomplete analysis");
  }
  return {
    recommendation: recommendation as "BUY" | "SELL" | "HOLD",
    confidence: Math.min(100, Math.max(0, Math.round(confidence))),
    summary: summary.trim(),
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 3),
  };
}

async function requestGeminiAnalysis(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const reservation = reserveGeminiAnalysis();
  if (reservation === null) {
    const error = new Error("Gemini analysis limit reached");
    error.name = "GeminiAnalysisLimitError";
    throw error;
  }

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          temperature: 0.2,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini returned HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned no analysis");
    return text;
  } catch (error) {
    releaseGeminiAnalysis(reservation);
    throw error;
  }
}

export async function analyzeElytraListing(context: ListingAnalysisContext) {
  const result = parseModelJson(await requestGeminiAnalysis([
    "You are a cautious Minecraft DonutSMP Elytra market analyst.",
    "Analyze this current listing using only the supplied data. Do not invent missing facts.",
    "Return JSON only with exactly these keys: recommendation, confidence, summary, reasons, risks.",
    'recommendation must be one of "BUY", "SELL", or "HOLD".',
    "confidence is an integer from 0 to 100 and represents confidence in the recommendation, not guaranteed accuracy.",
    "Use BUY when the listing is attractively priced versus the current market, SELL when the listing looks overpriced or selling is favorable, and HOLD when the data is too mixed or incomplete.",
    "Keep summary to two sentences maximum. Keep reasons and risks concise.",
    JSON.stringify({
      listing: context.listing,
      marketContext: context.marketContext,
    }),
  ].join("\n")));

  return {
    ...result,
    listing: context.listing,
    marketContext: context.marketContext,
    usage: getGeminiUsage(),
  };
}

function parseMarketModelJson(text: string): {
  recommendation: "YES" | "NO";
  confidence: number;
  summary: string;
  reasons: string[];
  risks: string[];
} {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini returned invalid market analysis JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Gemini returned an empty market analysis");
  const record = parsed as Record<string, unknown>;
  if (!["YES", "NO"].includes(String(record.recommendation)) ||
      typeof record.confidence !== "number" || !Number.isFinite(record.confidence) ||
      typeof record.summary !== "string" ||
      !Array.isArray(record.reasons) || !record.reasons.every((reason) => typeof reason === "string") ||
      !Array.isArray(record.risks) || !record.risks.every((risk) => typeof risk === "string")) {
    throw new Error("Gemini returned an incomplete market analysis");
  }
  return {
    recommendation: record.recommendation as "YES" | "NO",
    confidence: Math.min(100, Math.max(0, Math.round(record.confidence))),
    summary: record.summary.trim(),
    reasons: record.reasons.slice(0, 4) as string[],
    risks: record.risks.slice(0, 3) as string[],
  };
}

export async function analyzeElytraMarket(context: MarketAnalysisContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const prompt = [
    "You are a cautious Minecraft DonutSMP Elytra market analyst.",
    "Decide whether a player should buy an Elytra right now using only the supplied live auction pages and selected stored price history.",
    "Return JSON only with exactly these keys: recommendation, confidence, summary, reasons, risks.",
    'recommendation must be exactly "YES" when the evidence supports buying now, or exactly "NO" when the player should avoid buying or consider selling instead.',
    "confidence is an integer from 0 to 100 and represents confidence in the YES/NO decision, not guaranteed accuracy.",
    "Keep summary to two sentences maximum. Keep reasons and risks concise. Do not invent facts or use markdown.",
    JSON.stringify({
      auctionPageOne: context.pageOneListings,
      auctionPageTwo: context.pageTwoListings,
      selectedPriceHistory: context.hourlyHistory,
      marketContext: context.marketContext,
    }),
  ].join("\n");
  const marketResult = parseMarketModelJson(await requestGeminiAnalysis(prompt));
  return {
    ...marketResult,
    marketContext: context.marketContext,
    source: { auctionPages: [1, 2], historyRange: context.historyRange },
    usage: getGeminiUsage(),
  };
}