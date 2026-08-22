#!/usr/bin/env node
// ============================================================================
// Weekly Macro Indicators Digest — macro-digest.mjs
// One Telegram card per indicator (FRED + FX + computed Buffett), each
// followed by a single-indicator QuickChart line photo. Closes with an
// AI capex table sourced from SEC EDGAR XBRL, with manual estimates shown
// separately for entities that have no filed XBRL yet (OpenAI / Anthropic).
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchSeries, summarizeSeries, toYoYSeries, fetchNextReleaseDate } from './lib/fred.mjs';
import { fetchHistory } from './lib/yahoo.mjs';
import { buildSparklineUrl, buildMultiSparklineUrl, shortenChartUrl } from './lib/quickchart.mjs';
import { fetchLatestQuarterlyCapex, formatCapexB, shortPeriodLabel } from './lib/sec-edgar.mjs';

const FRED_API_KEY    = process.env.FRED_API_KEY || '';
const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!FRED_API_KEY) { console.error('ERROR: FRED_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)    { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../config/macro-indicators.json');
const OUTPUT_FILE = '/tmp/macro-briefing.md';
const DIGEST_TZ   = process.env.DIGEST_TIMEZONE || 'Australia/Sydney';

// -- Transforms -------------------------------------------------------------

function applyTransform(obs, transform) {
  if (transform === 'yoy') return toYoYSeries(obs);
  if (transform === 'mom_diff_k') {
    return obs.map((o, i) => {
      const prev = obs[i - 1];
      if (!prev) return null;
      return { date: o.date, value: o.value - prev.value };
    }).filter(Boolean);
  }
  return obs;
}

// -- Formatting helpers -----------------------------------------------------

function fmt(value, unit, precision) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(precision)}${unit || ''}`;
}

function fmtDeltaText(curr, prev, unit, precision) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return '—';
  const d = curr - prev;
  const eps = Math.pow(10, -precision - 1);
  if (Math.abs(d) < eps) return `→ 持平 (上期 ${prev.toFixed(precision)}${unit || ''})`;
  const arrow = d > 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(d).toFixed(precision)}${unit || ''} (上期 ${prev.toFixed(precision)}${unit || ''})`;
}

// FRED indexes an observation by the START of its period, so July CPI comes
// back as "2026-07-01" — accurate but it reads like "data as of 1 July".
// Render each series at its own granularity instead: a month for monthly
// data, a quarter for quarterly, the actual date for daily.
function inferFrequency(series) {
  if (!Array.isArray(series) || series.length < 3) return 'daily';
  const tail = series.slice(-7);
  const gaps = [];
  for (let i = 1; i < tail.length; i++) {
    gaps.push((Date.parse(tail[i].date) - Date.parse(tail[i - 1].date)) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median >= 75)  return 'quarterly';
  if (median >= 20)  return 'monthly';
  if (median >= 5)   return 'weekly';
  return 'daily';
}

function formatObsDate(dateStr, freq) {
  if (!dateStr || dateStr.length < 10) return dateStr || '—';
  const yr = dateStr.slice(0, 4);
  const mo = Number(dateStr.slice(5, 7));
  if (freq === 'monthly')   return `${yr} 年 ${mo} 月`;
  if (freq === 'quarterly') return `${yr} 年 Q${Math.ceil(mo / 3)}`;
  return dateStr;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Visual width = 2 cols for CJK ideographs, punctuation, full-width forms,
// common pictographs, and emoji (which Telegram renders at 2× width in
// monospace blocks). Everything else = 1 col.
const WIDE_RE = /[☀-➿　-〿㐀-鿿＀-￯\u{1F300}-\u{1FAFF}]/u;
function visualWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += (WIDE_RE.test(ch) ? 2 : 1);
  return w;
}
function padTo(s, width, align = 'left') {
  const pad = Math.max(0, width - visualWidth(s));
  return align === 'right' ? ' '.repeat(pad) + s : s + ' '.repeat(pad);
}

// Throttle parallel Promises to a max concurrency. FRED's stated rate is
// 120 req/min — bursts of 20 in 1s sometimes get 429. Limit to 4 in-flight.
async function pLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (err) { out[i] = { status: 'rejected', reason: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// -- Card renderer ----------------------------------------------------------

function renderCard({ shortName, zhName, description, summary, nextRelease, unit, precision, dataLabel = '數據日期', deltaLabel = '變動　', dataDate }) {
  const latestStr = fmt(summary.latest, unit, precision);
  const deltaStr  = fmtDeltaText(summary.latest, summary.previous, unit, precision);

  return [
    `🔹 <b>${escapeHtml(shortName)}</b> — ${escapeHtml(zhName)}`,
    escapeHtml(description),
    '',
    `• 最新值　　<b>${escapeHtml(latestStr)}</b>`,
    `• ${deltaLabel}　　${escapeHtml(deltaStr)}`,
    `• ${dataLabel}　${escapeHtml(dataDate || summary.latestDate || '—')}`,
    `• 下次發布　${escapeHtml(nextRelease || '—')}`,
  ].join('\n');
}

// -- Telegram delivery (with retry) ----------------------------------------

const DESTINATIONS = [
  { label: 'chat',    chatId: CHAT_ID },
  { label: 'channel', chatId: CHANNEL_CHAT_ID },
].filter(d => d.chatId);

async function fetchWithRetry(url, opts, { label, attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, opts);
      return res;
    } catch (err) {
      console.warn(`[${label}] fetch attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

// previewUrl (Bot API 7.0+): when set, Telegram renders a preview of that URL
// BELOW the message text in the same bubble (show_above_text: false).
// We use this to put chart photos beneath each indicator card without sending
// two messages.
async function sendMessage(text, parseMode, previewUrl) {
  for (const { label, chatId } of DESTINATIONS) {
    const body = { chat_id: chatId, text, parse_mode: parseMode };
    if (previewUrl) {
      body.link_preview_options = {
        is_disabled: false,
        url: previewUrl,
        show_above_text: false,
        prefer_large_media: true,
      };
    } else {
      body.disable_web_page_preview = true;
    }
    const res = await fetchWithRetry(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
      { label },
    );
    if (!res) {
      console.warn(`[${label}] sendMessage gave up after retries`);
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendMessage HTTP ${res.status}: ${err.slice(0, 300)}`);
    }
  }
}

// Telegram caption max length when parse_mode is HTML/MarkdownV2.
const CAPTION_MAX = 1024;

async function sendPhoto(photoUrl, caption, parseMode) {
  for (const { label, chatId } of DESTINATIONS) {
    const body = { chat_id: chatId, photo: photoUrl };
    if (caption) body.caption = caption;
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchWithRetry(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
      { label },
    );
    if (!res) {
      console.warn(`[${label}] sendPhoto gave up after retries`);
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendPhoto HTTP ${res.status}: ${err.slice(0, 300)}`);
    }
  }
}

// Send the card text with the chart attached as a *link preview* below the
// text. Single bubble, text on top, chart image on bottom — which is the
// natural reading order (sendPhoto + caption would put image first).
// QuickChart short URLs (image/png) generate Telegram previews reliably.
async function sendCardWithChart({ card, series, color, yUnit, captionLabel }) {
  let previewUrl = null;
  if (series && series.length > 0) {
    const longUrl = buildSparklineUrl(series, { label: captionLabel, color, yUnit });
    if (longUrl) {
      // Always shorten so the URL is small + cacheable by Telegram's preview
      // fetcher; long URLs (>3.5KB) often fail preview generation entirely.
      previewUrl = await shortenChartUrl(longUrl);
    }
  }
  await sendMessage(card, 'HTML', previewUrl);
}

// -- Buffett indicator: market cap (NCBEILQ027S, $B) ÷ GDP ($B) -----------

async function computeBuffett(cfg) {
  try {
    const [num, den] = await Promise.all([
      fetchSeries(cfg.numeratorSeriesId, { years: 5, apiKey: FRED_API_KEY }),
      fetchSeries(cfg.denominatorSeriesId, { years: 5, apiKey: FRED_API_KEY }),
    ]);
    if (!num.length || !den.length) return null;

    // FRED publishes the two legs in different units: NCBEILQ027S is Millions
    // of Dollars, GDP is Billions of Dollars. Without numeratorScale the ratio
    // comes out 1000x too large (≈2400x instead of ≈2.4x).
    const numScale = Number.isFinite(cfg.numeratorScale) ? cfg.numeratorScale : 1;
    const denScale = Number.isFinite(cfg.denominatorScale) ? cfg.denominatorScale : 1;

    // Both quarterly — align by date prefix (YYYY-MM).
    const denByMonth = new Map(den.map(d => [d.date.slice(0, 7), d.value * denScale]));
    const series = num.map(n => {
      const v = denByMonth.get(n.date.slice(0, 7));
      if (!Number.isFinite(v) || v === 0) return null;
      return { date: n.date, value: (n.value * numScale) / v };
    }).filter(Boolean);

    return { series, summary: summarizeSeries(series) };
  } catch (err) {
    console.warn(`  Buffett compute failed: ${err.message}`);
    return null;
  }
}

// -- Capex table renderer --------------------------------------------------

function renderCapexTable(rows, headers, cols) {
  // Sort by capex value desc; failed rows sink to the bottom.
  const sorted = [...rows].sort((a, b) => {
    const av = Number.isFinite(a.sortValue) ? a.sortValue : -Infinity;
    const bv = Number.isFinite(b.sortValue) ? b.sortValue : -Infinity;
    return bv - av;
  });

  // Short columns. Total width ~38-40 cols — wide enough to use the Telegram
  // bubble's horizontal real estate, narrow enough not to force it to grow.
  const widths = headers.map((h, i) => Math.max(
    visualWidth(h),
    ...sorted.map(r => visualWidth(String(r[cols[i]] || '—'))),
  ));

  const sep = widths.map(w => '─'.repeat(w)).join(' ');
  const lines = [
    headers.map((h, i) => padTo(h, widths[i])).join(' '),
    sep,
    ...sorted.map(r => cols.map((c, i) => padTo(
      String(r[c] || '—'),
      widths[i],
      i === 0 || i === cols.length - 1 ? 'left' : 'right',
    )).join(' ')),
  ];
  return lines.join('\n');
}

const ACTUAL_HEADERS = ['公司', 'Capex', 'QoQ', 'YoY', '期間'];
const ACTUAL_COLS    = ['name', 'value', 'qoq', 'yoy', 'period'];
const EST_HEADERS    = ['公司', '規模', '期間'];
const EST_COLS       = ['name', 'value', 'period'];

// "2026-03-31" → "26Q1"; "2025-12-31" → "25Q4". Used for chart x-axis ticks
// so MSFT (fiscal Q3 ending Mar) and AMZN (calendar Q1 ending Mar) share the
// same tick at calendar Q1. Table column keeps each company's reported fp.
function endDateToCalQ(end) {
  if (!end || end.length < 7) return end || '—';
  const yr = end.slice(2, 4);
  const m  = parseInt(end.slice(5, 7), 10);
  if (m <= 3)  return `${yr}Q1`;
  if (m <= 6)  return `${yr}Q2`;
  if (m <= 9)  return `${yr}Q3`;
  return `${yr}Q4`;
}

// Off-cycle fiscal calendars (Oracle ends May/Aug/Nov/Feb, Nvidia ends Jan)
// produce period-end dates that fall inside a calendar quarter rather than on
// its boundary. The chart's x-axis is keyed on the raw date, so those filers
// would each get their own tick — two adjacent columns both labelled "26Q1".
// Snap chart points to the calendar quarter-end they belong to; the table
// keeps every company's true reported period.
function snapToCalQuarterEnd(end) {
  if (!end || end.length < 10) return end;
  const yr = Number(end.slice(0, 4));
  const m  = Number(end.slice(5, 7));
  const qEndMonth = Math.ceil(m / 3) * 3;
  const lastDay = new Date(Date.UTC(yr, qEndMonth, 0)).getUTCDate();
  return `${yr}-${String(qEndMonth).padStart(2, '0')}-${lastDay}`;
}

function fmtDeltaPct(curr, base) {
  if (!Number.isFinite(curr) || !Number.isFinite(base) || base === 0) return '—';
  const pct = ((curr - base) / base) * 100;
  return `${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(0)}%`;
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log(`Fetching ${config.fred.length} FRED series + release dates (concurrency 2, ~1.4 req/sec)…`);
  const fredObsResults = await pLimit(
    config.fred, 2,
    cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY }),
  );
  const fredReleaseResults = await pLimit(
    config.fred, 2,
    cfg => fetchNextReleaseDate(cfg.seriesId, FRED_API_KEY),
  );
  const fredEntries = config.fred.map((cfg, i) => {
    const obsR = fredObsResults[i];
    const relR = fredReleaseResults[i];
    if (obsR.status !== 'fulfilled' || obsR.value.length === 0) {
      console.warn(`  FRED ${cfg.seriesId}: ${obsR.reason?.message || 'empty'}`);
      return { cfg, error: true };
    }
    const series = applyTransform(obsR.value, cfg.transform);
    const summary = summarizeSeries(series);
    const nextRelease = relR.status === 'fulfilled' ? relR.value : null;
    return { cfg, series, summary, nextRelease, freq: inferFrequency(series) };
  });

  console.log(`Fetching ${config.fx.length} Yahoo FX/index series (5y monthly for charts, 3mo daily for levels)...`);
  const fxResults = await Promise.allSettled(
    config.fx.map(cfg => fetchHistory(cfg.symbol, { range: '5y', interval: '1mo' })),
  );
  const fxDailyResults = await Promise.allSettled(
    config.fx.map(cfg => fetchHistory(cfg.symbol, { range: '3mo', interval: '1d' })),
  );
  const fxEntries = config.fx.map((cfg, i) => {
    const r = fxResults[i];
    const series = r.status === 'fulfilled' ? r.value : [];
    if (series.length === 0) console.warn(`  FX ${cfg.symbol}: ${r.reason?.message || 'empty'}`);

    // The last bar of a 5y/1mo series is the CURRENT, still-open month and is
    // dated the 1st of that month — quoting today's price under a "2026-08-01"
    // reference date. Take the level and the reference date off the daily
    // series instead, and compare against the close ~5 sessions back so the
    // delta is week-over-week, matching the cadence of this digest.
    const dr = fxDailyResults[i];
    const daily = dr.status === 'fulfilled' ? dr.value : [];
    const summary = daily.length > 0
      ? {
          latest: daily[daily.length - 1].value,
          previous: daily[Math.max(0, daily.length - 6)]?.value,
          latestDate: daily[daily.length - 1].date,
        }
      : summarizeSeries(series);
    if (daily.length === 0) console.warn(`  FX ${cfg.symbol} daily: ${dr.reason?.message || 'empty'} — falling back to monthly bars`);
    return { cfg, series, summary, weekly: daily.length > 0 };
  });

  console.log('Computing Buffett indicator (NCBEILQ027S / GDP)...');
  const buffettCfg = config.computed.find(c => c.id === 'buffett');
  const buffett = await computeBuffett(buffettCfg);

  // -- Header ------------------------------------------------------------
  // The workflow fires 21:00 UTC Friday so the digest lands Saturday morning
  // in Sydney. Dating it off the runner's UTC clock stamps it Friday; render
  // the header in the reader's timezone instead.
  const today = new Date().toLocaleDateString('zh-TW', {
    timeZone: DIGEST_TZ,
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  await sendMessage(`📊 <b>每週總經速報</b>\n${today}`, 'HTML');

  // -- FRED cards --------------------------------------------------------
  for (const entry of fredEntries) {
    const { cfg, series, summary, nextRelease, error, freq } = entry;
    if (error) {
      await sendMessage(
        `🔹 <b>${escapeHtml(cfg.shortName)}</b> — ${escapeHtml(cfg.zhName)}\n${escapeHtml(cfg.description || '')}\n\n⚠️ FRED 抓取失敗`,
        'HTML',
      );
      continue;
    }
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description || '',
      summary, nextRelease,
      unit: cfg.unit, precision: cfg.precision,
      dataDate: formatObsDate(summary.latestDate, freq),
    });
    await sendCardWithChart({
      card,
      series: cfg.chart ? series : null,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- FX / index cards --------------------------------------------------
  for (const entry of fxEntries) {
    const { cfg, series, summary, weekly } = entry;
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description || '',
      summary,
      nextRelease: '即時 (交易時段內持續更新)',
      unit: cfg.unit,
      precision: cfg.precision,
      dataLabel: '收盤日期',
      deltaLabel: weekly ? '週變動' : '月變動',
    });
    await sendCardWithChart({
      card,
      series: cfg.chart ? series : null,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- Buffett card ------------------------------------------------------
  if (buffett) {
    const card = renderCard({
      shortName: buffettCfg.shortName,
      zhName: buffettCfg.zhName,
      description: buffettCfg.description,
      summary: buffett.summary,
      nextRelease: '每季 Flow of Funds 與 GDP 更新時同步',
      unit: buffettCfg.unit,
      precision: buffettCfg.precision,
      dataLabel: '計算季別',
      dataDate: formatObsDate(buffett.summary.latestDate, 'quarterly'),
    });
    await sendCardWithChart({
      card,
      series: buffett.series,
      color: buffettCfg.color,
      yUnit: buffettCfg.unit,
      captionLabel: `${buffettCfg.shortName} — 近 5 年`,
    });
  } else {
    await sendMessage(`🔹 <b>${escapeHtml(buffettCfg.shortName)}</b> — ${escapeHtml(buffettCfg.zhName)}\n\n⚠️ FRED 抓取失敗`, 'HTML');
  }

  // -- AI Capex table + 6-quarter trend chart ----------------------------
  // Every company with a CIK goes to EDGAR; the manual estimate is only a
  // fallback for when EDGAR has nothing usable yet. That way a newly listed
  // filer (SpaceX in 2026-06) switches to real XBRL the quarter its first
  // 10-Q lands, and Anthropic will too once its CIK is filled in — no code
  // change, no `isPrivate` flag to remember to flip.
  console.log('Fetching AI capex from SEC EDGAR (estimates only where EDGAR has no XBRL)...');
  const filerEntries = config.capex.filter(c => c.cik);
  const capexResults = await pLimit(
    filerEntries, 3,
    c => fetchLatestQuarterlyCapex(c.cik, { historyCount: 6 }),
  );
  const filedByCompany = new Map();
  for (let i = 0; i < filerEntries.length; i++) {
    const r = capexResults[i];
    const name = filerEntries[i].company;
    if (r.status === 'fulfilled' && r.value) {
      const v = r.value;
      filedByCompany.set(name, v);
      console.log(`  ${name}: ${formatCapexB(v.value)} @ ${v.end} (${v.periodKind}${v.derived ? ', 差分' : ''}) ` +
                  `via ${v.concept}, ${v.history.length} 期`);
    } else if (r.status === 'rejected') {
      console.warn(`  capex ${name}: ${r.reason?.message}`);
    } else {
      console.warn(`  capex ${name}: no usable XBRL period found`);
    }
  }

  const actualRows = [];
  const estimateRows = [];
  const capexHistorySeries = [];
  let anyDerivedQ4 = false;

  for (const cfg of config.capex) {
    const v = filedByCompany.get(cfg.company);
    if (v) {
      if (v.derived) anyDerivedQ4 = true;
      actualRows.push({
        name:      cfg.company,
        value:     formatCapexB(v.value),
        // An annual-only filer (fresh S-1, no 10-Q yet) has no prior quarter;
        // its "previous" is the prior year, which the YoY column already says.
        qoq:       v.periodKind === 'FY' ? '—' : fmtDeltaPct(v.value, v.previousValue),
        yoy:       fmtDeltaPct(v.value, v.yoyValue),
        period:    v.periodKind === 'FY'
          ? shortPeriodLabel(v.end, 'FY')
          : endDateToCalQ(v.end) + (v.derived ? '*' : ''),
        sortValue: v.value,
      });

      // Chart series: date as YYYY-MM-DD for chronological sort, displayLabel
      // as calendar-quarter label so mixed-fiscal-year companies align on the
      // same x-axis ticks (MSFT FY-Q3 ending Mar and AMZN CY-Q1 ending Mar
      // share the "26Q1" tick).
      if (Array.isArray(v.history) && v.history.length >= 2) {
        if (v.history.some(h => h.derived)) anyDerivedQ4 = true;
        capexHistorySeries.push({
          label: cfg.company,
          points: v.history.map(h => ({
            date: snapToCalQuarterEnd(h.end),
            displayLabel: endDateToCalQ(h.end),
            value: h.value / 1e9,
          })),
        });
      }
      continue;
    }

    // No filed XBRL — fall back to the configured estimate, kept in its own
    // block. These are annual or multi-year figures and mostly cloud/lease
    // commitments rather than balance-sheet capex, so ranking them alongside
    // a single quarter of Meta PP&E would be an apples-to-oranges sort.
    const est = cfg.estimatedCapex;
    if (est && Number.isFinite(est.valueUSD)) {
      estimateRows.push({
        name:      `${cfg.company} 🔒`,
        value:     formatCapexB(est.valueUSD),
        period:    est.period,
        sortValue: est.valueUSD,
      });
    } else if (cfg.cik) {
      actualRows.push({ name: cfg.company, value: '—', qoq: '—', yoy: '—', period: '抓取失敗', sortValue: NaN });
    } else {
      estimateRows.push({ name: `${cfg.company} 🔒`, value: '—', period: '待估算', sortValue: NaN });
    }
  }

  const allFilersFailed = filerEntries.length > 0 && filedByCompany.size === 0;
  const capexTable = renderCapexTable(actualRows, ACTUAL_HEADERS, ACTUAL_COLS);
  const estTable   = estimateRows.length
    ? renderCapexTable(estimateRows, EST_HEADERS, EST_COLS)
    : '';
  const estNotes = config.capex
    .filter(c => !filedByCompany.has(c.company) && c.estimatedCapex)
    .map(c => `• ${c.company}：${c.estimatedCapex.source}`)
    .join('\n');

  const capexMsg =
    `💰 <b>AI Capex 追蹤</b>\n單季實際值，資料：SEC EDGAR XBRL 現金流量表 (PP&E 採購)\n\n` +
    (allFilersFailed
      ? `⚠️ SEC EDGAR 本次全數抓取失敗 (${filerEntries.length} 家)，本週無上市公司數據。\n` +
        `請查 Actions log 的 HTTP 狀態碼；403 通常代表 User-Agent 未帶聯絡 email，` +
        `可設 SEC_EDGAR_USER_AGENT 環境變數。`
      : `<pre>${escapeHtml(capexTable)}</pre>` +
        `\n<i>期間一律換算為日曆季 (Microsoft 6 月、Oracle 5 月結算會計年度已對齊)</i>` +
        (anyDerivedQ4 ? `\n<i>* 該季未單獨申報 (財報只揭露累計數)，由累計數差分還原；數值精確，非估算</i>` : '')) +
    (estTable
      ? `\n\n<b>未上市／尚無 XBRL (🔒 估算，非單季，口徑與上表不同)</b>\n` +
        `<pre>${escapeHtml(estTable)}</pre>`
      : '') +
    (estNotes ? `\n\n<i>估算來源</i>\n${escapeHtml(estNotes)}` : '');

  // Build trend chart (one combined line per company, last 6 periods, $B).
  let capexChartUrl = null;
  if (capexHistorySeries.length > 0) {
    const longUrl = buildMultiSparklineUrl(capexHistorySeries, {
      title: 'AI Capex 趨勢 — 近 6 個財季 ($B，僅已申報者)',
      yUnit: 'B',
      width: 700,
      height: 340,
    });
    if (longUrl) {
      capexChartUrl = longUrl.length > 3500 ? await shortenChartUrl(longUrl) : longUrl;
    }
  }

  await sendMessage(capexMsg, 'HTML', capexChartUrl);

  // -- Artifact ----------------------------------------------------------
  const briefing = [
    `📊 每週總經速報 — ${today}`,
    '',
    ...fredEntries.map(e => e.error
      ? `${e.cfg.shortName}: FRED 抓取失敗`
      : `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${formatObsDate(e.summary.latestDate, e.freq)} | next: ${e.nextRelease || '—'}`),
    ...fxEntries.map(e => `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${e.summary.latestDate || '—'}`),
    buffett ? `Buffett: ${fmt(buffett.summary.latest, 'x', 2)} @ ${formatObsDate(buffett.summary.latestDate, 'quarterly')}` : 'Buffett: failed',
    '',
    'AI Capex (filed, quarterly):',
    capexTable,
    ...(estTable ? ['', 'AI Capex (estimates):', estTable] : []),
  ].join('\n');
  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);
  console.log('Delivered to Telegram successfully');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
