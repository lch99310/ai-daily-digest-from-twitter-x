// FRED (St. Louis Fed) API client with DBnomics fallback.
// FRED requires FRED_API_KEY env var (free); DBnomics is keyless and mirrors
// the FRED catalogue at `FRED/{seriesId}` — used automatically when FRED
// itself is rate-limiting or returning a transient error.
// Docs: https://fred.stlouisfed.org/docs/api/  |  https://api.db.nomics.world/

const TIMEOUT = 12_000;
const MAX_ATTEMPTS = 3;

// FRED limits API keys to 120 requests/minute (= 2/sec). Even with a 4-way
// concurrency cap, our burst of 8 series × {obs, release, dates} ≈ 24 calls
// could briefly exceed 2/sec and trigger 429. We enforce a global ~700ms gap
// between call STARTS via a module-level last-call timestamp; combined with
// concurrency=2 in the caller this guarantees ~1.4 req/sec sustained.
let _lastFredCallAt = 0;
const FRED_MIN_GAP_MS = 700;

async function fredRateLimitWait() {
  const now = Date.now();
  const wait = Math.max(0, _lastFredCallAt + FRED_MIN_GAP_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastFredCallAt = Date.now();
}

// Retry transient failures with linear backoff. 429 uses a longer base delay
// to let the rate window roll forward. Non-retryable (400/401/403) fails fast.
async function fredGet(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await fredRateLimitWait();
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) throw err;
      console.warn(`  FRED ${label} attempt ${attempt}/${MAX_ATTEMPTS} network err: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (res.ok) return res.json();

    const body = await res.text();
    lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw lastErr;
    if (attempt === MAX_ATTEMPTS) throw lastErr;
    const backoff = res.status === 429 ? 2000 * attempt : 800 * attempt;
    console.warn(`  FRED ${label} attempt ${attempt}/${MAX_ATTEMPTS} got ${res.status}, retrying in ${backoff}ms…`);
    await new Promise(r => setTimeout(r, backoff));
  }
  throw lastErr;
}

// DBnomics period formats vary by frequency: "YYYY" / "YYYY-QX" / "YYYY-MM"
// / "YYYY-MM-DD". Normalize all to YYYY-MM-DD (period-end semantics).
function dbnomicsPeriodToDate(period) {
  if (/^\d{4}$/.test(period)) return `${period}-12-31`;
  if (/^\d{4}-Q[1-4]$/.test(period)) {
    const [yr, q] = period.split('-');
    const end = { Q1: '03-31', Q2: '06-30', Q3: '09-30', Q4: '12-31' }[q];
    return `${yr}-${end}`;
  }
  if (/^\d{4}-\d{2}$/.test(period)) return `${period}-01`;
  return period;
}

async function fetchSeriesDBnomics(seriesId, { years = 5 } = {}) {
  // DBnomics organizes FRED data by RELEASE (e.g. UNRATE is in CES, DFF in
  // H15) — there is no canonical "dataset = series_id" rule. Use the search
  // filter endpoint which finds a series by code across all FRED datasets.
  const url = `https://api.db.nomics.world/v22/series?provider_code=FRED&series_code=${encodeURIComponent(seriesId)}&observations=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`DBnomics HTTP ${res.status}`);
  const data = await res.json();
  const doc = data.series?.docs?.[0];
  if (!doc) throw new Error('DBnomics returned no series doc');

  const periods = doc.period || [];
  const values  = doc.value  || [];
  const cutoff  = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const out = [];
  for (let i = 0; i < periods.length; i++) {
    const v = values[i];
    if (v === 'NA' || v == null) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    const date = dbnomicsPeriodToDate(periods[i]);
    if (date < cutoffStr) continue;
    out.push({ date, value: num });
  }
  return out;
}

export async function fetchSeries(seriesId, { years = 5, apiKey } = {}) {
  // Try FRED first (more authoritative, has release metadata).
  if (apiKey) {
    try {
      const obsStart = new Date();
      obsStart.setFullYear(obsStart.getFullYear() - years);
      const startStr = obsStart.toISOString().slice(0, 10);

      const url =
        `https://api.stlouisfed.org/fred/series/observations` +
        `?series_id=${encodeURIComponent(seriesId)}` +
        `&api_key=${encodeURIComponent(apiKey)}` +
        `&file_type=json` +
        `&observation_start=${startStr}` +
        `&sort_order=asc`;
      const data = await fredGet(url, seriesId);

      const obs = (data.observations || [])
        .filter(o => o.value !== '.' && o.value != null)
        .map(o => ({ date: o.date, value: Number(o.value) }))
        .filter(o => Number.isFinite(o.value));

      if (obs.length > 0) return obs;
      console.warn(`  FRED ${seriesId} returned 0 rows, trying DBnomics fallback…`);
    } catch (err) {
      console.warn(`  FRED ${seriesId} failed (${err.message.slice(0, 80)}), trying DBnomics fallback…`);
    }
  }

  // Fall back to DBnomics — same data, no API key required.
  return await fetchSeriesDBnomics(seriesId, { years });
}

// Returns { latest, previous, latestDate, deltaSign }.
export function summarizeSeries(obs) {
  if (!obs || obs.length === 0) return {};
  const latest = obs[obs.length - 1];
  const previous = obs[obs.length - 2];
  let deltaSign = '';
  if (previous && Number.isFinite(previous.value)) {
    if (latest.value > previous.value) deltaSign = '↑';
    else if (latest.value < previous.value) deltaSign = '↓';
    else deltaSign = '→';
  }
  return {
    latest: latest.value,
    previous: previous?.value,
    latestDate: latest.date,
    deltaSign,
  };
}

// Next scheduled release date for a series, via FRED's release calendar.
// Returns YYYY-MM-DD string or null if unavailable.
export async function fetchNextReleaseDate(seriesId, apiKey) {
  if (!apiKey) return null;
  try {
    // Step 1: find the release_id that owns this series.
    const relUrl =
      `https://api.stlouisfed.org/fred/series/release?series_id=${encodeURIComponent(seriesId)}` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const relData = await fredGet(relUrl, `${seriesId}/release`);
    const releaseId = relData.releases?.[0]?.id;
    if (!releaseId) return null;

    // Step 2: list future release dates (include "no data yet" entries).
    // realtime_end must be pinned to the far future: FRED defaults it to today
    // on most endpoints, which would return only dates that have already
    // happened. We then drop anything <= today, because a release scheduled
    // for this morning is not a "next release".
    const today = new Date().toISOString().slice(0, 10);
    const datesUrl =
      `https://api.stlouisfed.org/fred/release/dates` +
      `?release_id=${releaseId}` +
      `&realtime_start=${today}` +
      `&realtime_end=9999-12-31` +
      `&include_release_dates_with_no_data=true` +
      `&sort_order=asc&limit=10` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const datesData = await fredGet(datesUrl, `${seriesId}/dates`);
    const upcoming = (datesData.release_dates || [])
      .map(d => d.date)
      .filter(d => d && d > today)
      .sort();
    return upcoming[0] || null;
  } catch (err) {
    console.warn(`  next-release lookup for ${seriesId} failed: ${err.message}`);
    return null;
  }
}

// Compute YoY % change series from a level series.
export function toYoYSeries(obs) {
  if (!obs || obs.length < 13) return [];
  return obs.map((o, i) => {
    const yearAgo = obs[i - 12];
    if (!yearAgo) return null;
    return { date: o.date, value: ((o.value - yearAgo.value) / yearAgo.value) * 100 };
  }).filter(Boolean);
}
