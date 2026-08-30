import { Router, type IRouter, type Response } from "express";
import {
  GetElytraAlertsQueryParams,
  GetElytraAlertsResponse,
  GetElytraDashboardResponse,
  GetElytraHistoryQueryParams,
  GetElytraHistoryResponse,
  GetElytraListingsQueryParams,
  GetElytraListingsResponse,
  GetElytraTransactionsQueryParams,
  GetElytraTransactionsResponse,
  AnalyzeElytraListingBody,
  AnalyzeElytraListingResponse,
  AnalyzeElytraMarketBody,
  AnalyzeElytraMarketResponse,
} from "@workspace/api-zod";
import { elytraMarketService } from "../lib/elytra-market";
import { analyzeElytraListing, analyzeElytraMarket, GEMINI_ANALYSIS_LIMIT, getGeminiUsage } from "../lib/gemini-analysis";

const router: IRouter = Router();

function invalidQuery(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

router.get("/elytra/dashboard", async (_req, res): Promise<void> => {
  const data = await elytraMarketService.getDashboard();
  res.json(GetElytraDashboardResponse.parse(data));
});

router.get("/elytra/history", async (req, res): Promise<void> => {
  const parsed = GetElytraHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  const data = await elytraMarketService.getHistory(parsed.data.category, parsed.data.range);
  res.json(GetElytraHistoryResponse.parse(data));
});

router.get("/elytra/listings", async (req, res): Promise<void> => {
  const parsed = GetElytraListingsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  const data = await elytraMarketService.getListings(parsed.data.category, parsed.data.sort);
  res.json(GetElytraListingsResponse.parse(data));
});

router.get("/elytra/transactions", async (req, res): Promise<void> => {
  const parsed = GetElytraTransactionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  const data = await elytraMarketService.getTransactions(parsed.data.category);
  res.json(GetElytraTransactionsResponse.parse(data));
});

router.get("/elytra/alerts", async (req, res): Promise<void> => {
  const parsed = GetElytraAlertsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  const data = await elytraMarketService.getAlerts(parsed.data.limit, parsed.data.threshold);
  res.json(GetElytraAlertsResponse.parse(data));
});

router.post("/elytra/analyze", async (req, res): Promise<void> => {
  const parsed = AnalyzeElytraListingBody.safeParse(req.body);
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  const context = await elytraMarketService.getListingAnalysisContext(parsed.data.listingId);
  if (!context) {
    res.status(404).json({ error: "Listing is no longer active" });
    return;
  }
  if (getGeminiUsage().used >= GEMINI_ANALYSIS_LIMIT) {
    res.status(429).json({ error: "Gemini analysis limit reached", usage: getGeminiUsage() });
    return;
  }
  try {
    const data = await analyzeElytraListing(context);
    res.json(AnalyzeElytraListingResponse.parse(data));
  } catch (error) {
    if (error instanceof Error && error.name === "GeminiAnalysisLimitError") {
      res.status(429).json({ error: error.message, usage: getGeminiUsage() });
      return;
    }
    const message = error instanceof Error ? error.message : "Gemini analysis failed";
    res.status(502).json({ error: message, usage: getGeminiUsage() });
  }
});

router.post("/elytra/analyze-market", async (req, res): Promise<void> => {
  const parsed = AnalyzeElytraMarketBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    invalidQuery(res, parsed.error.message);
    return;
  }
  if (getGeminiUsage().used >= GEMINI_ANALYSIS_LIMIT) {
    res.status(429).json({ error: "Gemini analysis limit reached", usage: getGeminiUsage() });
    return;
  }
  try {
    const context = await elytraMarketService.getMarketAnalysisContext(parsed.data.range);
    const data = await analyzeElytraMarket(context);
    res.json(AnalyzeElytraMarketResponse.parse(data));
  } catch (error) {
    if (error instanceof Error && error.name === "GeminiAnalysisLimitError") {
      res.status(429).json({ error: error.message, usage: getGeminiUsage() });
      return;
    }
    const message = error instanceof Error ? error.message : "Gemini market analysis failed";
    res.status(502).json({ error: message, usage: getGeminiUsage() });
  }
});

export default router;