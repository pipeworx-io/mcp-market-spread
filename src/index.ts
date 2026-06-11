interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * market-spread MCP — cross-venue prediction-market landscape scanner.
 *
 * For a given topic, shows how 5 venues price it side by side and highlights
 * divergence: Polymarket, Kalshi, Manifold, PredictIt, Futuur.
 *
 * This is a LANDSCAPE / DIVERGENCE scanner, NOT an executable-arbitrage tool.
 * It surfaces where to LOOK for mispricing. A high cross-venue spread usually
 * reflects different bet shapes / resolution criteria / liquidity rather than a
 * real, tradeable arbitrage. Always verify the questions resolve identically
 * before acting, and for executable poly↔kalshi arb (which needs order-book
 * depth) use the `polymarket_arbitrage` pack instead.
 *
 * Keyless. Every upstream request sends UA pipeworx/1.0 (+https://pipeworx.io).
 */


const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const HEADERS = { Accept: 'application/json', 'User-Agent': UA } as const;
const TIMEOUT_MS = 8000;

type VenueId = 'polymarket' | 'kalshi' | 'manifold' | 'predictit' | 'futuur';

interface NormMarket {
  venue: VenueId;
  title: string;
  implied_probability: number | null; // 0-1 for the main/YES outcome, or null
  url: string | null;
  n_outcomes: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'compare_topic',
    description:
      "Cross-venue prediction-market LANDSCAPE scanner: for one topic, show how 5 venues (Polymarket, Kalshi, Manifold, PredictIt, Futuur) are pricing it side by side and flag divergence. Each venue is queried in parallel; a venue that errors or times out is reported as { reachable: false } and never fails the call. Returns each venue's top matches normalized to { venue, title, implied_probability (0-1 for the main/YES outcome, or null), url, n_outcomes }, plus a divergence summary across venues' top matches. " +
      "HONESTY: this surfaces WHERE TO LOOK for mispricing — it is NOT an executable-arb tool. A high spread_pp usually reflects different bet shapes, resolution criteria, dates, or thin liquidity, not a real arbitrage. Divergence is only computed when ≥2 venues' top titles share strong token overlap (Jaccard); otherwise divergence is null with a low-match-quality note telling you to compare manually. Verify the questions resolve identically before trading. For executable poly↔kalshi arbitrage (needs order-book depth) use the `polymarket_arbitrage` pack.",
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Topic / question to scan across venues, e.g. "bitcoin 100k", "fed rate cut", "2028 president", "government shutdown", "trump".',
        },
        per_venue: {
          type: 'number',
          description: 'Top matches to show per venue (default 3, max 5).',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'venue_quotes',
    description:
      "Single-venue drill-down: fetch one venue's current top 5 matches for a query, each as { title, implied_probability (0-1 or null), url }. Useful after compare_topic to look closer at one venue. Implied probability is the main/YES outcome where available; multi-outcome markets report the top outcome and note it. Keyless.",
    inputSchema: {
      type: 'object',
      properties: {
        venue: {
          type: 'string',
          description: 'One of: polymarket, kalshi, manifold, predictit, futuur.',
        },
        query: { type: 'string', description: 'Question / topic text to search on that venue.' },
      },
      required: ['venue', 'query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'compare_topic':
        return compareTopic(args);
      case 'venue_quotes':
        return venueQuotes(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'of', 'in', 'on', 'by', 'to', 'be', 'is', 'are', 'at', 'for',
  'and', 'or', 'with', 'this', 'that', 'it', 'as', 'before', 'after', 'than', 'who', 'which',
  'what', 'when', 'reach', 'hit', 'above', 'below', 'over', 'under', 'next', 'another', 'any',
  '2024', '2025', '2026', '2027', '2028', '2029', '2030',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function parsePolyPrices(raw: unknown): number | null {
  // Polymarket outcomePrices is a JSON-encoded string like "[\"0.62\",\"0.38\"]".
  try {
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as unknown[]) : (raw as unknown[]);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const p = Number(arr[0]);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

function kalshiProb(m: Record<string, unknown>): number | null {
  // Kalshi nested-market fields are already 0-1 (the *_dollars variants).
  const last = Number(m.last_price_dollars);
  if (Number.isFinite(last) && last > 0) return round(last, 4);
  const bid = Number(m.yes_bid_dollars);
  const ask = Number(m.yes_ask_dollars);
  if (Number.isFinite(bid) && Number.isFinite(ask) && (bid > 0 || ask > 0)) {
    return round((bid + ask) / 2, 4);
  }
  if (Number.isFinite(bid) && bid > 0) return round(bid, 4);
  if (Number.isFinite(ask) && ask > 0) return round(ask, 4);
  return null;
}

// ---------------------------------------------------------------------------
// Per-venue fetchers — each returns NormMarket[] or throws (caught upstream).
// ---------------------------------------------------------------------------

async function fetchManifold(query: string, limit: number): Promise<NormMarket[]> {
  const url = `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(query)}&limit=${limit}&filter=open&contractType=BINARY`;
  const data = (await fetchJson(url)) as Array<Record<string, unknown>>;
  const arr = Array.isArray(data) ? data : [];
  return arr.slice(0, limit).map((m) => {
    const p = Number(m.probability);
    return {
      venue: 'manifold' as const,
      title: String(m.question ?? ''),
      implied_probability: Number.isFinite(p) ? round(p, 4) : null,
      url: typeof m.url === 'string' ? m.url : null,
      n_outcomes: 2,
    };
  });
}

async function fetchPolymarket(query: string, limit: number): Promise<NormMarket[]> {
  const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`;
  const data = (await fetchJson(url)) as Record<string, unknown>;
  const events = Array.isArray(data.events) ? (data.events as Array<Record<string, unknown>>) : [];
  const out: NormMarket[] = [];
  for (const e of events.slice(0, limit)) {
    const markets = Array.isArray(e.markets) ? (e.markets as Array<Record<string, unknown>>) : [];
    const slug = typeof e.slug === 'string' ? e.slug : '';
    const eventTitle = String(e.title ?? '');
    // Prefer the first Yes/No market for a clean YES probability.
    let prob: number | null = null;
    let mNote: string | undefined;
    if (markets.length > 0) {
      const yesNo = markets.find((m) => {
        try {
          const oc =
            typeof m.outcomes === 'string' ? (JSON.parse(m.outcomes) as unknown[]) : (m.outcomes as unknown[]);
          return Array.isArray(oc) && oc.length === 2 && String(oc[0]).toLowerCase() === 'yes';
        } catch {
          return false;
        }
      });
      const chosen = yesNo ?? markets[0];
      prob = parsePolyPrices(chosen.outcomePrices);
      if (markets.length > 1) mNote = `multi-market event (${markets.length}); YES prob is for "${String(chosen.question ?? '').slice(0, 60)}"`;
    }
    out.push({
      venue: 'polymarket',
      title: eventTitle,
      implied_probability: prob,
      url: slug ? `https://polymarket.com/event/${slug}` : null,
      n_outcomes: markets.length || 0,
      note: mNote,
    });
  }
  return out;
}

async function fetchKalshi(query: string, limit: number): Promise<NormMarket[]> {
  // Kalshi has no full-text topic search; pull a page of open events and filter
  // client-side on title relevance.
  const url = `https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true`;
  const data = (await fetchJson(url)) as Record<string, unknown>;
  const events = Array.isArray(data.events) ? (data.events as Array<Record<string, unknown>>) : [];
  const qTokens = tokenize(query);
  const scored: Array<{ score: number; m: NormMarket }> = [];
  for (const e of events) {
    const title = String(e.title ?? '');
    const sub = String(e.sub_title ?? '');
    const haystack = `${title} ${sub}`;
    const ht = tokenize(haystack);
    let overlap = 0;
    for (const w of qTokens) if (ht.has(w)) overlap++;
    if (overlap === 0) continue;
    const markets = Array.isArray(e.markets) ? (e.markets as Array<Record<string, unknown>>) : [];
    const m0 = markets[0] as Record<string, unknown> | undefined;
    const slug = typeof e.series_ticker === 'string' ? e.series_ticker : '';
    const ticker = typeof e.event_ticker === 'string' ? e.event_ticker : '';
    scored.push({
      score: overlap / Math.max(1, qTokens.size),
      m: {
        venue: 'kalshi',
        title: sub ? `${title} — ${sub}` : title,
        implied_probability: m0 ? kalshiProb(m0) : null,
        url: ticker ? `https://kalshi.com/markets/${slug}` : null,
        n_outcomes: markets.length || 0,
        note: markets.length > 1 ? `multi-market event (${markets.length}); prob is first market` : undefined,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

async function fetchPredictit(query: string, limit: number): Promise<NormMarket[]> {
  const data = (await fetchJson('https://www.predictit.org/api/marketdata/all/')) as Record<string, unknown>;
  const markets = Array.isArray(data.markets) ? (data.markets as Array<Record<string, unknown>>) : [];
  const qTokens = tokenize(query);
  const scored: Array<{ score: number; m: NormMarket }> = [];
  for (const mk of markets) {
    const name = String(mk.name ?? '');
    const contracts = Array.isArray(mk.contracts) ? (mk.contracts as Array<Record<string, unknown>>) : [];
    // Score on market name plus contract names.
    const haystack = `${name} ${contracts.map((c) => String(c.name ?? '')).join(' ')}`;
    const ht = tokenize(haystack);
    let overlap = 0;
    for (const w of qTokens) if (ht.has(w)) overlap++;
    if (overlap === 0) continue;
    // Top contract by displayOrder (PredictIt's own ordering).
    const sortedC = [...contracts].sort(
      (a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0),
    );
    const top = sortedC[0];
    const ltp = top ? Number(top.lastTradePrice) : NaN;
    const multi = contracts.length > 1;
    scored.push({
      score: overlap / Math.max(1, qTokens.size),
      m: {
        venue: 'predictit',
        title: multi && top ? `${name} → ${String(top.name ?? '')}` : name,
        implied_probability: Number.isFinite(ltp) ? round(ltp, 4) : null,
        url: typeof mk.url === 'string' ? mk.url : null,
        n_outcomes: contracts.length || 0,
        note: multi ? `multi-outcome (${contracts.length}); prob is top contract only` : undefined,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

async function fetchFutuur(query: string, limit: number): Promise<NormMarket[]> {
  const url = `https://api.futuur.com/api/v1/markets/?search=${encodeURIComponent(query)}&limit=${limit}`;
  const data = (await fetchJson(url)) as Record<string, unknown>;
  const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
  return results.slice(0, limit).map((m) => {
    const outcomes = Array.isArray(m.outcomes) ? (m.outcomes as Array<Record<string, unknown>>) : [];
    const isBinary = m.is_binary === true;
    const slug = typeof m.slug === 'string' ? m.slug : '';
    // Main outcome: for binary, the first (YES-equivalent); otherwise the top-priced.
    let main = outcomes[0];
    if (!isBinary && outcomes.length > 0) {
      main = [...outcomes].sort((a, b) => {
        const pa = priceOf(a);
        const pb = priceOf(b);
        return (pb ?? -1) - (pa ?? -1);
      })[0];
    }
    const prob = main ? priceOf(main) : null;
    const multi = !isBinary && outcomes.length > 1;
    return {
      venue: 'futuur' as const,
      title: multi && main ? `${String(m.title ?? '')} → ${String(main.title ?? '')}` : String(m.title ?? ''),
      implied_probability: prob,
      url: slug ? `https://futuur.com/q/${slug}` : null,
      n_outcomes: outcomes.length || 0,
      note: multi ? `multi-outcome (${outcomes.length}); prob is top outcome only` : undefined,
    };
  });
}

function priceOf(outcome: Record<string, unknown>): number | null {
  const price = outcome.price as Record<string, unknown> | undefined;
  if (!price) return null;
  const usdc = Number(price.USDC);
  if (Number.isFinite(usdc)) return round(usdc, 4);
  const oom = Number(price.OOM);
  if (Number.isFinite(oom)) return round(oom, 4);
  return null;
}

const FETCHERS: Record<VenueId, (q: string, limit: number) => Promise<NormMarket[]>> = {
  polymarket: fetchPolymarket,
  kalshi: fetchKalshi,
  manifold: fetchManifold,
  predictit: fetchPredictit,
  futuur: fetchFutuur,
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function compareTopic(args: Record<string, unknown>): Promise<unknown> {
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  if (!topic) return { error: 'provide a topic', topic: args.topic ?? null };
  let perVenue = Number(args.per_venue);
  if (!Number.isFinite(perVenue) || perVenue < 1) perVenue = 3;
  perVenue = Math.min(5, Math.floor(perVenue));

  const venueIds: VenueId[] = ['polymarket', 'kalshi', 'manifold', 'predictit', 'futuur'];
  const settled = await Promise.allSettled(venueIds.map((v) => FETCHERS[v](topic, perVenue)));

  const venues: Record<string, unknown> = {};
  const topMatches: NormMarket[] = [];
  venueIds.forEach((v, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      const markets = r.value;
      venues[v] = { reachable: true, markets };
      if (markets.length > 0) topMatches.push(markets[0]);
    } else {
      const reason = r.reason;
      venues[v] = {
        reachable: false,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  });

  const divergence = computeDivergence(topMatches);

  return { topic, per_venue: perVenue, venues, divergence };
}

function computeDivergence(topMatches: NormMarket[]): unknown {
  // Consider only venues whose top match has a non-null probability.
  const priced = topMatches.filter((m) => typeof m.implied_probability === 'number');
  if (priced.length < 2) {
    return {
      matched_venues: [],
      note: 'fewer than 2 venues returned a priced top match for this topic',
    };
  }

  // Find the largest cluster of priced top matches whose titles agree (Jaccard ≥ 0.4).
  let bestCluster: NormMarket[] = [];
  for (let i = 0; i < priced.length; i++) {
    const cluster = [priced[i]];
    for (let j = 0; j < priced.length; j++) {
      if (j === i) continue;
      if (jaccard(priced[i].title, priced[j].title) >= 0.4) cluster.push(priced[j]);
    }
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }

  if (bestCluster.length < 2) {
    return {
      matched_venues: [],
      match_quality: 'low — titles not clearly the same question; compare manually',
      candidates: priced.map((m) => ({
        venue: m.venue,
        title: m.title,
        implied_probability: m.implied_probability,
      })),
    };
  }

  const probs = bestCluster.map((m) => m.implied_probability as number);
  const min = Math.min(...probs);
  const max = Math.max(...probs);
  return {
    matched_venues: bestCluster.map((m) => m.venue),
    min_probability: round(min, 4),
    max_probability: round(max, 4),
    spread_pp: round((max - min) * 100, 1),
    matched_titles: bestCluster.map((m) => ({ venue: m.venue, title: m.title, implied_probability: m.implied_probability })),
    note:
      'Spread is a LANDSCAPE signal, not an executable arb. A wide spread often reflects different resolution criteria, dates, or thin liquidity rather than mispricing — verify the questions resolve identically before trading. For executable poly↔kalshi arb (needs order-book depth) use polymarket_arbitrage.',
  };
}

async function venueQuotes(args: Record<string, unknown>): Promise<unknown> {
  const venue = (typeof args.venue === 'string' ? args.venue.trim().toLowerCase() : '') as VenueId;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!FETCHERS[venue]) {
    return { error: 'venue must be one of: polymarket, kalshi, manifold, predictit, futuur', venue: args.venue ?? null };
  }
  if (!query) return { error: 'provide a query', query: args.query ?? null };

  try {
    const markets = await FETCHERS[venue](query, 5);
    return {
      venue,
      query,
      count: markets.length,
      markets: markets.map((m) => ({
        title: m.title,
        implied_probability: m.implied_probability,
        url: m.url,
        n_outcomes: m.n_outcomes,
        ...(m.note ? { note: m.note } : {}),
      })),
    };
  } catch (e) {
    return { venue, query, reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
