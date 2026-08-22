// SEC EDGAR companyconcept API — capex from XBRL filings.
// Free, no API key, but SEC gates automated traffic on the User-Agent: it must
// carry a CONTACT EMAIL ADDRESS in the form "Company Name contact@domain.com".
// A UA without an email — a bare product string, or one carrying only a URL —
// gets a blanket 403 "Your Request Originates from an Undeclared Automated
// Tool" on every endpoint. Set SEC_EDGAR_USER_AGENT to your own real contact.
// https://www.sec.gov/os/webmaster-faq#developers

const UA = process.env.SEC_EDGAR_USER_AGENT
  || 'My Daily Digest macro-digest contact@example.com';
const TIMEOUT = 12_000;

// SEC asks automated clients to stay under 10 requests/second. We issue
// 6 concepts x N companies; a 120ms floor between request starts keeps us
// comfortably inside that regardless of the caller's concurrency.
let _lastCallAt = 0;
const MIN_GAP_MS = 120;

// Trip after a few 403s: a rejected User-Agent fails identically for every
// request, so retrying the rest of the run only burns the job's time budget.
let _forbiddenCount = 0;
const FORBIDDEN_TRIP = 3;
async function rateLimitWait() {
  const wait = Math.max(0, _lastCallAt + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallAt = Date.now();
}

const CAPEX_CONCEPTS = [
  // us-gaap variants — companies pick whichever fits their disclosure style.
  // Amazon historically reported under PaymentsToAcquirePropertyPlantAnd-
  // Equipment but later split capex into multiple concepts incl. finance
  // leases; we pool data from every concept and pick the newest.
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireMachineryAndEquipment',
  'PaymentsToAcquireOtherProductiveAssets',
  'PaymentsForPropertyPlantAndEquipment',
];

// Last-resort matcher, used only when none of CAPEX_CONCEPTS returns data:
// swept across every taxonomy in companyfacts so company extension elements
// are reachable too. Requiring the verb and the noun as separate tests rather
// than one glued pattern matters — a filer that names its element
// "PaymentsForPropertyEquipmentAndSatellites" has neither the exact string
// "PropertyAndEquipment" nor "PropertyPlantAndEquipment" in it, and a rigid
// pattern silently misses it.
const CAPEX_VERB_RE = /(Payments?|Purchases?|Expenditures?)/i;
const CAPEX_NOUN_RE = /(PropertyPlantAndEquipment|PropertyAndEquipment|PropertyEquipment|ProductiveAssets|CapitalExpenditure|CapitalImprovement|MachineryAndEquipment|ConstructionInProgress|Satellite)/i;
// Balances, disposals and non-cash disclosures use the same nouns.
const CAPEX_EXCLUDE_RE = /(Proceeds|Sales?Of|Disposal|Disposed|Noncash|NonCash|Accrued|Depreciation|Amortization|Impairment|Useful|Gross|Net(Book)?Value|Lease)/i;

function looksLikeCapexConcept(name) {
  return CAPEX_VERB_RE.test(name)
      && CAPEX_NOUN_RE.test(name)
      && !CAPEX_EXCLUDE_RE.test(name);
}

// Forms that legitimately disclose periodic capex via XBRL.
// 10-Q / 10-K = ongoing US filers. S-1 = IPO prospectus (used by companies
// like SpaceX in the window between registration and their first 10-Q).
const ACCEPTED_FORMS = new Set([
  '10-Q', '10-Q/A',
  '10-K', '10-K/A',
  '20-F', '20-F/A',
  'S-1',  'S-1/A',
  'F-1',  'F-1/A',
]);

// Cash-flow items come in two shapes and you cannot tell them apart from
// `fp` alone, because a 10-Q tags its 3-month and its year-to-date column
// under the SAME `end` and `fp`:
//
//   Amazon, Microsoft  — 10-Q shows a three-month column AND a YTD column
//   Alphabet, Meta,    — 10-Q cash-flow statement shows ONLY the YTD column
//   Oracle               (Oracle's Q3 10-Q is headed "Nine Months Ended")
//
// So we keep every 3/6/9/12-month period, then reduce to discrete quarters:
// a filed 3-month figure is used as-is, and where only YTD exists the quarter
// is recovered by differencing consecutive steps of the same fiscal-year
// chain (Q3 = 9-month − 6-month, Q4 = FY − 9-month). Differencing is exact,
// not an estimate. Filtering to 3-month periods only — which is what a naive
// YTD guard does — silently strands a YTD-only filer at its fiscal Q1, the
// one quarter where YTD and the discrete quarter coincide.
const MIN_DAYS = 80, MAX_DAYS = 400;
const DAYS_PER_MONTH = 30.4375;

function durationDays(start, end) {
  if (!start || !end) return null;
  const d = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

// Length of the period in months, snapped to the only values a cash-flow
// column can legitimately have. Anything else (a stub period, a 52/53-week
// oddity outside tolerance) returns null and is dropped.
function periodMonths(start, end) {
  const days = durationDays(start, end);
  if (days == null || days < MIN_DAYS || days > MAX_DAYS) return null;
  const months = Math.round(days / DAYS_PER_MONTH);
  return [3, 6, 9, 12].includes(months) ? months : null;
}

function periodKindFor(start, end) {
  const months = periodMonths(start, end);
  if (months === 3)  return 'Q';
  if (months === 12) return 'FY';
  return months ? 'YTD' : null;
}

// Calendar arithmetic on YYYY-MM-DD strings, clamped to month end so
// 2026-03-31 minus 1 month is 2026-02-28, not 2026-03-03.
function addMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

// Nearest entry whose `end` is within `tolDays` of the target date. Fiscal
// calendars drift (52/53-week years, month-end vs Saturday-end), so exact
// string matching drops real quarters.
function findNearEnd(list, targetEnd, tolDays) {
  let best = null;
  let bestDiff = Infinity;
  const target = Date.parse(targetEnd);
  for (const u of list) {
    const diff = Math.abs(Date.parse(u.end) - target) / 86_400_000;
    if (diff <= tolDays && diff < bestDiff) { best = u; bestDiff = diff; }
  }
  return best;
}

// SEC returns 403 both for a rejected User-Agent and for exceeding the rate
// threshold, and the two are only distinguishable from the response body — so
// carry a snippet of it into the error. Retry 403/429/5xx a couple of times:
// a rate-limit 403 clears, a UA rejection will not, and the body then says
// which one you are looking at.
async function getJson(url, { attempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await rateLimitWait();
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) throw err;
      await new Promise(r => setTimeout(r, 800 * attempt));
      continue;
    }

    if (res.ok) return res.json();

    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    lastErr = new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    if (res.status === 404) throw lastErr;                     // concept not reported
    if (res.status === 403 && ++_forbiddenCount === FORBIDDEN_TRIP) {
      console.warn(`  SEC EDGAR is refusing this client (403). Check the User-Agent carries a contact email — set SEC_EDGAR_USER_AGENT. Response: ${body.slice(0, 160)}`);
    }
    const rateLimited = res.status === 429 || res.status >= 500
      || (res.status === 403 && _forbiddenCount < FORBIDDEN_TRIP);
    if (!rateLimited || attempt === attempts) throw lastErr;
    await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  throw lastErr;
}

// Returns { value, end, fp, fy, form, previousValue, previousEnd, periodKind,
//           yoyValue, yoyEnd, derived, history } where `history` is oldest →
// newest last N periods usable for charting; each item is
// {date, end, fp, value, derived}.
//
// Strategy: pool entries from ALL capex concepts (Amazon and others split
// capex across several), keep only true 3-month and 12-month durations, then
// synthesize the missing Q4 (a 10-K reports the fiscal year, never its
// fourth quarter separately) as FY − (Q1 + Q2 + Q3).
export async function fetchLatestQuarterlyCapex(cik, { historyCount = 6 } = {}) {
  const padded = String(cik).padStart(10, '0');

  // (start + end) → entry; later filings win, then earlier concepts. Keying
  // on the full period (not just `end`) is what lets the 3-month and the YTD
  // column of the same 10-Q coexist instead of overwriting each other.
  const byKey = new Map();
  const conceptsSeen = new Set();

  const absorb = (u, concept, rank) => {
    if (!ACCEPTED_FORMS.has(u.form)) return;
    const months = periodMonths(u.start, u.end);
    if (!months) return;
    const key = `${u.start}|${u.end}`;
    const prev = byKey.get(key);
    const wins = !prev
      || u.filed > prev.filed
      || (u.filed === prev.filed && rank < prev.conceptRank);
    if (wins) byKey.set(key, { ...u, months, concept, conceptRank: rank });
    conceptsSeen.add(concept);
  };

  for (let rank = 0; rank < CAPEX_CONCEPTS.length; rank++) {
    const concept = CAPEX_CONCEPTS[rank];
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`;
      const data = await getJson(url);
      for (const u of data.units?.USD || []) absorb(u, concept, rank);
    } catch (err) {
      // 404 = company doesn't report under this concept; that's fine.
      // Match on the status prefix — the body snippet may itself contain "404".
      if (!String(err.message).startsWith('HTTP 404')) {
        console.warn(`  CIK ${padded} ${concept}: ${err.message}`);
      }
    }
  }

  // None of the well-known us-gaap concepts hit. A recent filer may tag capex
  // under a company extension element (SpaceX is a live example), so sweep
  // companyfacts for anything capex-shaped in any taxonomy. One extra request,
  // and only on the path where we would otherwise return nothing at all.
  if (byKey.size === 0) {
    try {
      const data = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`);
      const candidates = [];
      const rejectedPeriods = [];
      for (const [taxonomy, concepts] of Object.entries(data.facts || {})) {
        for (const [name, def] of Object.entries(concepts)) {
          if (!looksLikeCapexConcept(name)) continue;
          const usd = def.units?.USD || [];
          candidates.push(`${taxonomy}:${name}(${usd.length})`);
          const before = byKey.size;
          for (const u of usd) absorb(u, `${taxonomy}:${name}`, CAPEX_CONCEPTS.length);
          if (byKey.size === before && usd.length) {
            const sample = usd[usd.length - 1];
            rejectedPeriods.push(`${name} ${sample.form} ${sample.start}→${sample.end}`);
          }
        }
      }

      if (byKey.size > 0) {
        console.log(`  CIK ${padded}: matched via companyfacts sweep — ${[...conceptsSeen].join(', ')}`);
      } else {
        // Nothing usable. Dump enough of the company's own taxonomy to say
        // WHY on the next run: either no capex-shaped element exists (list the
        // near misses) or one does but its periods were rejected.
        const near = [];
        for (const [taxonomy, concepts] of Object.entries(data.facts || {})) {
          for (const name of Object.keys(concepts)) {
            if (/Propert|Capital|Purchase|Payment|Equipment|Satellite/i.test(name)) near.push(`${taxonomy}:${name}`);
          }
        }
        console.warn(`  CIK ${padded}: companyfacts has no usable capex fact.`);
        if (candidates.length)      console.warn(`    matched names : ${candidates.slice(0, 12).join(', ')}`);
        if (rejectedPeriods.length) console.warn(`    periods dropped: ${rejectedPeriods.slice(0, 6).join(' | ')}`);
        console.warn(`    near misses   : ${near.slice(0, 25).join(', ') || '(none)'}${near.length > 25 ? ` …+${near.length - 25}` : ''}`);
      }
    } catch (err) {
      console.warn(`  CIK ${padded} companyfacts sweep: ${err.message}`);
    }
  }

  if (byKey.size === 0) return null;

  const all    = [...byKey.values()];
  const annual = all.filter(u => u.months === 12);

  // Reduce to discrete quarters. A filed 3-month figure wins outright; every
  // other quarter is recovered by differencing its fiscal-year chain. Chain
  // members all share the fiscal year's `start`, so grouping on it separates
  // the YTD ladder from the standalone 3-month facts automatically.
  const discreteByEnd = new Map();
  for (const u of all) {
    if (u.months !== 3) continue;
    const prev = discreteByEnd.get(u.end);
    if (!prev || u.filed > prev.filed) discreteByEnd.set(u.end, { ...u, derived: false });
  }

  const chains = new Map();
  for (const u of all) {
    if (!chains.has(u.start)) chains.set(u.start, []);
    chains.get(u.start).push(u);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.months - b.months);
    for (let i = 1; i < chain.length; i++) {
      const cur = chain[i], prior = chain[i - 1];
      if (cur.months - prior.months !== 3) continue;   // need a contiguous step
      if (discreteByEnd.has(cur.end)) continue;        // a filed 3-month wins
      const val = cur.val - prior.val;
      if (!Number.isFinite(val) || val < 0) continue;
      discreteByEnd.set(cur.end, {
        ...cur,
        val,
        start: prior.end,
        months: 3,
        fp: cur.fp === 'FY' ? 'Q4' : cur.fp,
        derived: true,
      });
    }
  }

  const quarterly = [...discreteByEnd.values()].map(u => ({ ...u, periodKind: 'Q' }));
  quarterly.sort((a, b) => b.end.localeCompare(a.end));
  annual.sort((a, b) => b.end.localeCompare(a.end));
  for (const u of annual) u.periodKind = 'FY';

  const pool = quarterly.length > 0 ? quarterly : annual;
  if (pool.length === 0) return null;

  const latest = pool[0];

  // Match QoQ / YoY counterparts by calendar distance, not array index —
  // index arithmetic silently compares Q2 against Q1-of-last-year whenever a
  // period is missing from the pool.
  const backMonths = latest.periodKind === 'Q' ? 3 : 12;
  const prev = findNearEnd(pool.slice(1), addMonths(latest.end, -backMonths), 20);
  const yoy  = latest.periodKind === 'Q'
    ? findNearEnd(pool.slice(1), addMonths(latest.end, -12), 25)
    : findNearEnd(pool.slice(1), addMonths(latest.end, -12), 60);

  const history = pool
    .slice(0, historyCount)
    .reverse()
    .map(u => ({ date: u.end, end: u.end, value: u.val, fp: u.fp, derived: !!u.derived }));

  return {
    value: latest.val,
    end: latest.end,
    fp: latest.fp,
    fy: latest.fy,
    form: latest.form,
    filed: latest.filed,
    concept: latest.concept,
    periodKind: latest.periodKind,
    derived: !!latest.derived,
    previousValue: prev?.val,
    previousEnd: prev?.end,
    yoyValue: yoy?.val,
    yoyEnd: yoy?.end,
    history,
  };
}

export function formatCapexB(usd) {
  if (!Number.isFinite(usd)) return '—';
  if (usd >= 1e9)  return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6)  return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${usd.toFixed(0)}`;
}

// Compact period label, unified across quarterly and annual:
//   "2026-06-30" + "Q2" → "26Q2"      (quarterly filing)
//   "2025-12-31" + "FY" → "Y25"        (annual filing, actuals)
// Private-company estimates supply their own "Y26E" string via config.
// `derived` marks a Q4 we computed as FY − (Q1+Q2+Q3) rather than read
// straight off a filing.
export function shortPeriodLabel(end, fp, derived = false) {
  if (!end) return fp || '—';
  const yr = end.slice(2, 4);
  if (fp === 'FY') return `Y${yr}`;
  return `${yr}${fp || ''}${derived ? '*' : ''}`;
}

export { addMonths, periodKindFor, findNearEnd };
