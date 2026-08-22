// SEC EDGAR companyconcept API — capex from XBRL filings.
// Free, no API key. SEC requires a descriptive User-Agent that identifies the
// requester; override with SEC_EDGAR_USER_AGENT if you want your own contact.
// https://www.sec.gov/edgar/sec-api-documentation

const UA = process.env.SEC_EDGAR_USER_AGENT
  || 'My Daily Digest macro-digest (+https://github.com/lch99310/My_Daily_Digest)';
const TIMEOUT = 12_000;

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

// A quarter is ~91 days, a fiscal year ~365. Anything in between (a 6-month
// or 9-month year-to-date column, which every 10-Q tags alongside the
// 3-month one under the SAME `end` and `fp`) is discarded — mixing those in
// is what makes a "quarterly" capex figure silently balloon to a YTD total.
const Q_MIN_DAYS = 80,  Q_MAX_DAYS = 100;
const FY_MIN_DAYS = 330, FY_MAX_DAYS = 400;

function durationDays(start, end) {
  if (!start || !end) return null;
  const d = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

function periodKindFor(start, end) {
  const days = durationDays(start, end);
  if (days == null) return null;
  if (days >= Q_MIN_DAYS  && days <= Q_MAX_DAYS)  return 'Q';
  if (days >= FY_MIN_DAYS && days <= FY_MAX_DAYS) return 'FY';
  return null;
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

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

  // (end + periodKind) → entry; later filings win, then earlier concepts.
  const byKey = new Map();

  for (let rank = 0; rank < CAPEX_CONCEPTS.length; rank++) {
    const concept = CAPEX_CONCEPTS[rank];
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`;
      const data = await getJson(url);
      const usd = data.units?.USD || [];

      for (const u of usd) {
        if (!ACCEPTED_FORMS.has(u.form)) continue;
        const kind = periodKindFor(u.start, u.end);
        if (!kind) continue;  // drops 6-month / 9-month YTD duplicates
        const key = `${u.end}|${kind}`;
        const prev = byKey.get(key);
        const wins = !prev
          || u.filed > prev.filed
          || (u.filed === prev.filed && rank < prev.conceptRank);
        if (wins) byKey.set(key, { ...u, periodKind: kind, concept, conceptRank: rank });
      }
    } catch (err) {
      // 404 = company doesn't report under this concept; that's fine.
      if (!String(err.message).includes('404')) {
        console.warn(`  CIK ${padded} ${concept}: ${err.message}`);
      }
    }
  }

  if (byKey.size === 0) return null;

  const all       = [...byKey.values()];
  const quarterly = all.filter(u => u.periodKind === 'Q');
  const annual    = all.filter(u => u.periodKind === 'FY');

  // Derive the fourth fiscal quarter from the 10-K. Without this the
  // quarterly series silently skips one quarter a year — which both breaks
  // the trend chart and makes a June-fiscal-year filer (Microsoft) look a
  // quarter staler than its calendar-year peers.
  for (const fy of annual) {
    if (findNearEnd(quarterly, fy.end, 20)) continue;  // Q4 already tagged
    const q3 = findNearEnd(quarterly, addMonths(fy.end, -3), 20);
    const q2 = findNearEnd(quarterly, addMonths(fy.end, -6), 20);
    const q1 = findNearEnd(quarterly, addMonths(fy.end, -9), 20);
    if (!q1 || !q2 || !q3) continue;
    const val = fy.val - (q1.val + q2.val + q3.val);
    if (!Number.isFinite(val) || val <= 0) continue;
    quarterly.push({
      ...fy,
      val,
      start: addMonths(fy.end, -3),
      periodKind: 'Q',
      fp: 'Q4',
      derived: true,
    });
  }

  quarterly.sort((a, b) => b.end.localeCompare(a.end));
  annual.sort((a, b) => b.end.localeCompare(a.end));

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
