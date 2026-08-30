import type { ElytraListing } from "@workspace/api-zod";

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
export const GEMINI_ANALYSIS_LIMIT = 5;

let geminiAnalysisCount = 0;

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
  return {
    used: geminiAnalysisCount,
    remaining: Math.max(0, GEMINI_ANALYSIS_LIMIT - geminiAnalysisCount),
    limit: GEMINI_ANALYSIS_LIMIT,
  };
}

function reserveGeminiAnalysis(): boolean {
  if (geminiAnalysisCount >= GEMINI_ANALYSIS_LIMIT) return false;
  geminiAnalysisCount += 1;
  return true;
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

export async function analyzeElytraListing(context: ListingAnalysisContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  if (!reserveGeminiAnalysis()) {
    const error = new Error("Gemini analysis limit reached");
    error.name = "GeminiAnalysisLimitError";
    throw error;
  }

  const prompt = [
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
  ].join("\n");

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

  return {
    ...parseModelJson(text),
    listing: context.listing,
    marketContext: context.marketContext,
    usage: getGeminiUsage(),
  };
}