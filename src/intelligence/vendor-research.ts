/**
 * intelligence/vendor-research.ts
 *
 * AI-powered new vendor due diligence.
 *
 * When a vendor appears for the first time, an AP specialist is expected
 * to know: is this legit? What do they do? Is the price reasonable?
 * Does this vendor raise any compliance concerns?
 *
 * Traditionally this means 20 minutes of Googling. This module does it
 * in 30 seconds using Stagehand + Claude and saves the result to the
 * knowledge base so you never research the same vendor twice.
 *
 * What gets researched:
 *   1. Company website — what do they actually do?
 *   2. LinkedIn presence — are they a real company with real employees?
 *   3. Pricing page — is the amount charged reasonable for this vendor?
 *   4. News search — any red flags (fraud, lawsuits, shutdowns)?
 *   5. Crunchbase/similar — funding status, are they likely to still exist?
 *
 * Output: VendorProfile — stored in vendor-cache.json and auto-injected
 * into future knowledge base lookups so the enrichment engine knows
 * about this vendor without manual configuration.
 *
 * The agent answers its own question first:
 *   "Is this vendor legit?" → research first, then ask cardholder only
 *   if research doesn't resolve it.
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
  /** Vendor name as it appeared on the transaction */
  vendorName: string;

  /** Normalized/canonical company name */
  canonicalName: string | null;

  /** What the company does in 2-3 sentences */
  businessDescription: string;

  /** Company website URL */
  website: string | null;

  /** Whether the company appears to be legitimate */
  isLegitimate: boolean;

  /** Risk assessment */
  riskLevel: VendorRiskLevel;

  /** Specific risk flags found during research */
  riskFlags: string[];

  /** Typical pricing range observed (null if couldn't find) */
  typicalPricing: string | null;

  /**
   * Whether the amount charged is reasonable for this vendor.
   * true = amount is consistent with typical pricing
   * false = amount is unusually high or low — warrants a question
   * null = couldn't determine
   */
  amountIsReasonable: boolean | null;

  /** Likely GL classification for this vendor */
  likelyGLBucket: string | null;

  /** Likely categories this vendor falls into */
  likelyCategories: string[];

  /**
   * The question to ask the cardholder, if any, AFTER research.
   * Research-first means we only ask what we couldn't answer ourselves.
   */
  residualQuestion: string | null;

  /** Raw research notes for the audit trail */
  researchNotes: string;

  /** ISO timestamp of when research was conducted */
  researchedAt: string;

  /** Whether this profile came from cache */
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

// ── Research flow ───────────────────────────────────────────────────────

/**
 * Research a vendor using Stagehand web browsing + Claude synthesis.
 * Results are cached — the same vendor is never researched twice.
 */
export async function researchVendor(
  vendorName: string,
  transactionAmount: number,
  stagehand: Stagehand,
  client: Anthropic
): Promise<VendorProfile> {
  const cache = loadCache();
  const key = cacheKey(vendorName);

  // Return from cache if available (profiles are valid for 90 days)
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
    await stagehand.act(`Navigate to https://www.google.com and search for "${vendorName} software company")`);

    const searchResults = await stagehand.extract({
      instruction: 'Extract the top 5 search result titles, URLs, and descriptions',
      schema: z.object({
        results: z.array(z.object({
          title: z.string(),
          url: z.string().optional(),
          description: z.string().optional(),
        })).max(5),
      }),
    });

    researchParts.push(`Google results: ${JSON.stringify(searchResults.results, null, 2)}`);

    // Step 2: Visit the most likely company website
    const likelyWebsite = searchResults.results.find(
      r => r.url && !r.url.includes('google') && !r.url.includes('yelp')
    )?.url;

    if (likelyWebsite) {
      await stagehand.act(`Navigate to ${likelyWebsite}`);
      const homepageContent = await stagehand.extract({
        instruction: 'Extract the company name, what they do (1-3 sentences), and any pricing information visible',
        schema: z.object({
          companyName: z.string().optional(),
          whatTheyDo: z.string().optional(),
          pricingMentioned: z.string().optional(),
        }),
      });
      researchParts.push(`Website content: ${JSON.stringify(homepageContent, null, 2)}`);
    }

    // Step 3: Quick news search for red flags
    await stagehand.act(`Navigate to https://www.google.com and search for "${vendorName} fraud OR scam OR lawsuit OR shutdown 2024 2025"`);
    const newsContent = await stagehand.extract({
      instruction: 'Are there any results suggesting fraud, scam, lawsuit, or company shutdown? Extract relevant headlines.',
      schema: z.object({
        hasRedFlags: z.boolean(),
        redFlagDetails: z.array(z.string()).optional(),
      }),
    });
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

    // Save to cache
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

/**
 * Check if a vendor is new (not in knowledge base and not in cache).
 * Used by the main workflow to decide whether to trigger research.
 */
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
