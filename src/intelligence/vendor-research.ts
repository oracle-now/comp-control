/**
 * intelligence/vendor-research.ts
 *
 * AI-powered new vendor due diligence.
 *
 * Stagehand v3: extract() uses positional args — extract(instruction, schema)
 * NOT the old object form { instruction, schema }.
 */

import type { Stagehand } from '@browserbasehq/stagehand';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type VendorRiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface VendorProfile {
  vendorName: string;
  canonicalName: string | null;
  businessDescription: string;
  website: string | null;
  isLegitimate: boolean;
  riskLevel: VendorRiskLevel;
  riskFlags: string[];
  typicalPricing: string | null;
  amountIsReasonable: boolean | null;
  likelyGLBucket: string | null;
  likelyCategories: string[];
  residualQuestion: string | null;
  researchNotes: string;
  researchedAt: string;
  fromCache: boolean;
}

// ── Cache ─────────────────────────────────────────────────────────────────

const CACHE_PATH = path.resolve(process.cwd(), 'data/vendor-cache.json');

function loadCache(): Record<string, VendorProfile> {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCache(cache: Record<string, VendorProfile>): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cacheKey(vendorName: string): string {
  return vendorName.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// ── Zod schemas for extract() calls ─────────────────────────────────────
// v3: extract(instruction, schema) — positional args, zod schema required

const searchResultsSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string().optional(),
    description: z.string().optional(),
  })).max(5),
});

const homepageSchema = z.object({
  companyName: z.string().optional(),
  whatTheyDo: z.string().optional(),
  pricingMentioned: z.string().optional(),
});

const redFlagSchema = z.object({
  hasRedFlags: z.boolean(),
  redFlagDetails: z.array(z.string()).optional(),
});

// ── Research flow ───────────────────────────────────────────────────────

export async function researchVendor(
  vendorName: string,
  transactionAmount: number,
  stagehand: Stagehand,
  client: Anthropic
): Promise<VendorProfile> {
  const cache = loadCache();
  const key = cacheKey(vendorName);

  if (cache[key]) {
    const cached = cache[key];
    const age = Date.now() - new Date(cached.researchedAt).getTime();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    if (age < ninetyDays) {
      log.info(`[VendorResearch] Cache hit for "${vendorName}"`);
      return { ...cached, fromCache: true };
    }
  }

  log.info(`[VendorResearch] Researching new vendor: "${vendorName}"`);

  const researchParts: string[] = [];

  try {
    // Step 1: Google the vendor name
    await stagehand.act(`Navigate to https://www.google.com and search for "${vendorName} software company"`);

    // v3: positional args — extract(instruction, schema)
    const searchResults = await stagehand.extract(
      'Extract the top 5 search result titles, URLs, and descriptions',
      searchResultsSchema,
    );
    researchParts.push(`Google results: ${JSON.stringify(searchResults.results, null, 2)}`);

    // Step 2: Visit the most likely company website
    const likelyWebsite = searchResults.results.find(
      (r: { url?: string }) => r.url && !r.url.includes('google') && !r.url.includes('yelp')
    )?.url;

    if (likelyWebsite) {
      await stagehand.act(`Navigate to ${likelyWebsite}`);
      const homepageContent = await stagehand.extract(
        'Extract the company name, what they do (1-3 sentences), and any pricing information visible',
        homepageSchema,
      );
      researchParts.push(`Website content: ${JSON.stringify(homepageContent, null, 2)}`);
    }

    // Step 3: Quick news search for red flags
    await stagehand.act(`Navigate to https://www.google.com and search for "${vendorName} fraud OR scam OR lawsuit OR shutdown 2024 2025"`);
    const newsContent = await stagehand.extract(
      'Are there any results suggesting fraud, scam, lawsuit, or company shutdown? Extract relevant headlines.',
      redFlagSchema,
    );
    researchParts.push(`Red flag search: ${JSON.stringify(newsContent, null, 2)}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    researchParts.push(`Research error: ${msg}`);
    log.warn(`[VendorResearch] Partial research failure for "${vendorName}": ${msg}`);
  }

  // Step 4: Synthesize with Claude
  const synthesisPrompt = `You are an AP specialist doing vendor due diligence.

Vendor name as it appeared on a corporate card transaction: "${vendorName}"
Amount charged: $${transactionAmount}

Research gathered:
${researchParts.join('\n\n')}

Based on this research, produce a vendor profile. Be direct and specific.
If you can answer a question from the research, answer it — don't pass it to the cardholder.
Only ask the cardholder what the research genuinely couldn't answer.

Output JSON only:
{
  "canonicalName": string | null,
  "businessDescription": string,
  "website": string | null,
  "isLegitimate": boolean,
  "riskLevel": "low" | "medium" | "high" | "unknown",
  "riskFlags": string[],
  "typicalPricing": string | null,
  "amountIsReasonable": boolean | null,
  "likelyGLBucket": "COGS" | "RD" | "SM" | "GA" | "CAPEX" | "PREPAID" | null,
  "likelyCategories": string[],
  "residualQuestion": string | null,
  "researchNotes": string
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: synthesisPrompt }],
    });

    const raw = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '{}';
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());

    const profile: VendorProfile = {
      vendorName,
      ...parsed,
      researchedAt: new Date().toISOString(),
      fromCache: false,
    };

    cache[key] = profile;
    saveCache(cache);

    log.info(`[VendorResearch] "${vendorName}" → ${profile.riskLevel} risk, ${profile.isLegitimate ? 'legitimate' : 'FLAGGED'}`);
    return profile;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[VendorResearch] Synthesis failed for "${vendorName}": ${msg}`);

    const fallback: VendorProfile = {
      vendorName,
      canonicalName: null,
      businessDescription: 'Could not research this vendor automatically.',
      website: null,
      isLegitimate: false,
      riskLevel: 'unknown',
      riskFlags: ['Research failed — manual review required'],
      typicalPricing: null,
      amountIsReasonable: null,
      likelyGLBucket: null,
      likelyCategories: [],
      residualQuestion: `Can you confirm what "${vendorName}" is and the business purpose of this $${transactionAmount} charge?`,
      researchNotes: `Automated research failed: ${msg}`,
      researchedAt: new Date().toISOString(),
      fromCache: false,
    };

    cache[key] = fallback;
    saveCache(cache);
    return fallback;
  }
}

export function isNewVendor(
  vendorName: string,
  knownVendorPatterns: string[]
): boolean {
  const lower = vendorName.toLowerCase();
  const isKnown = knownVendorPatterns.some(p => lower.includes(p.toLowerCase()));
  if (isKnown) return false;

  const cache = loadCache();
  return !cache[cacheKey(vendorName)];
}
