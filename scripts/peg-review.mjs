#!/usr/bin/env node
// ============================================================================
// Monthly PEG Review — peg-review.mjs
// For each ticker: pull 30 days of news + latest AI capex trends, ask LLM
// (DeepSeek-first) to recommend a new PEG with reasoning + confidence. Apply
// safety filter (max change ±0.3, min confidence 0.7, hard floor/ceiling),
// write updates to config/stock-tickers.json, and send a Telegram summary.
// The committing back to git is done by the workflow, not this script.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchFeed, dedupeByTitle, filterByAge, sortByDateDesc } from './lib/rss.mjs';
import { fetchLatestQuarterlyCapex, formatCapexB, shortPeriodLabel } from './lib/sec-edgar.mjs';
import { callLLMReliable } from './lib/llm.mjs';

const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!BOT_TOKEN) { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname        = dirname(fileURLToPath(import.meta.url));
const STOCK_CFG_PATH   = resolve(__dirname, '../config/stock-tickers.json');
const MACRO_CFG_PATH   = resolve(__dirname, '../config/macro-indicators.json');
const FRAMEWORK_PATH   = resolve(__dirname, '../config/peg-framework.md');
const NEWS_LOOKBACK_HOURS = 30 * 24;  // 30 days
const NEWS_PER_TICKER     = 20;       // headlines fed to LLM per ticker

// -- News collection (Google News with 30d filter) -------------------------

async function fetchTickerNews(ticker) {
  const q = encodeURIComponent(`when:30d ${ticker.searchKeywords || ticker.symbol}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchFeed({ name: ticker.symbol, url, ua: 'peg-review/1.0' });
  const fresh = sortByDateDesc(dedupeByTitle(filterByAge(items, NEWS_LOOKBACK_HOURS)));
  return fresh.slice(0, NEWS_PER_TICKER);
}

// -- Capex context (reuse macro config + sec-edgar lib) --------------------

async function fetchCapexContext(macroConfig) {
  const publicEntries = macroConfig.capex.filter(c => !c.isPrivate && c.cik);
  const results = await Promise.allSettled(
    publicEntries.map(c => fetchLatestQuarterlyCapex(c.cik, { historyCount: 6 })),
  );
  const lines = [];
  for (let i = 0; i < publicEntries.length; i++) {
    const c = publicEntries[i];
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) {
      lines.push(`- ${c.company}: 抓取失敗`);
      continue;
    }
    const v = r.value;
    const yoy = (Number.isFinite(v.previousValue) && Number.isFinite(v.yoyValue) && v.yoyValue !== 0)
      ? `YoY ${((v.value - v.yoyValue) / v.yoyValue * 100).toFixed(0)}%`
      : 'YoY n/a';
    const periodLabel = shortPeriodLabel(v.end, v.fp);
    lines.push(`- ${c.company}: ${formatCapexB(v.value)} ${periodLabel} (${yoy})`);
  }
  return lines.join('\n');
}

// -- LLM prompt ------------------------------------------------------------

function buildPrompt({ tickers, newsByTicker, capexBlock, globals, framework }) {
  const today = new Date().toISOString().slice(0, 10);
  const floor = globals.pegReview?.absoluteFloor ?? 1.0;
  const ceiling = globals.pegReview?.absoluteCeiling ?? 2.5;
  const maxChange = globals.pegReview?.maxMonthlyChange ?? 0.3;

  const tickerBlocks = tickers.map(t => {
    const news = newsByTicker[t.symbol] || [];
    const newsLines = news.length === 0
      ? '(無新聞素材)'
      : news.map((n, i) => `${i + 1}. ${n.title}${n.desc ? ' — ' + n.desc.slice(0, 200) : ''}`).join('\n');

    // Fresh fundamentals (just refreshed by cache-refresh.mjs earlier in
    // the chain). Letting the LLM see these lets it factor in EPS/FCF
    // momentum, growth-rate revisions and beta drift — i.e. it can lower
    // PEG when growth estimates compress, raise it when EPS surprises up.
    const c = t.cache || {};
    const a = t.analysisAssumptions || {};
    const fundLine = [
      `EPS(TTM) ${c.eps ?? '—'}`,
      `FCF/sh ${c.fcfPerShare ?? '—'}`,
      `Beta ${c.beta ?? '—'}`,
      `5Y 成長預估 ${Number.isFinite(c.growth5y) ? (c.growth5y * 100).toFixed(1) + '%' : '—'}`,
    ].join(' · ');
    const assumptionLine = [
      `EPS ${a.eps ?? '—'}`,
      `FCF/sh ${a.fcfPerShare ?? '—'}`,
      `Beta ${a.beta ?? '—'}`,
      `5Y 成長假設 ${Number.isFinite(a.growth5y) ? (a.growth5y * 100).toFixed(1) + '%' : '—'}`,
      `PEG ${a.pegMultiplier ?? t.pegOverride ?? '—'}`,
      `來源 ${a.source ?? '—'} ${a.asOf ?? ''}`.trim(),
    ].join(' · ');

    // Fundamental trajectory — last up-to-3 cache-refresh deltas. Reveals
    // whether growth/EPS are being revised up or down month over month.
    const history = Array.isArray(c.history) ? c.history.slice(-3) : [];
    const trajectoryLines = history.length > 0
      ? history.map(h => {
          const bits = [];
          if (h.changes?.eps) bits.push(`EPS ${h.changes.eps.from}→${h.changes.eps.to}`);
          if (h.changes?.fcfPerShare) bits.push(`FCF/sh ${h.changes.fcfPerShare.from}→${h.changes.fcfPerShare.to}`);
          if (h.changes?.growth5y) {
            const f = (h.changes.growth5y.from * 100).toFixed(1);
            const tt = (h.changes.growth5y.to * 100).toFixed(1);
            bits.push(`成長 ${f}%→${tt}%`);
          }
          if (h.changes?.beta) bits.push(`Beta ${h.changes.beta.from}→${h.changes.beta.to}`);
          return `  ${h.date}: ${bits.join(', ') || '(無欄位變動)'}`;
        }).join('\n')
      : '  (無歷史記錄)';

    return `### ${t.symbol} — ${t.zhName}
當前 PEG: ${t.pegOverride}
上次 PEG 調整 (${t.pegLastChange}) 理由: ${t.pegRationale}
分類描述: ${t.description}

最新基本面 (本月剛 refresh): ${fundLine}
目前 daily digest 使用的報告重估假設: ${assumptionLine}
近 3 次 cache-refresh 變化:
${trajectoryLines}

近 30 天新聞:
${newsLines}`;
  }).join('\n\n');

  return `你是 sell-side equity research 資深分析師，今天是 ${today}，月度檢視一組 AI 相關成長股的 PEG 估值倍數。
PEG = 合理 P/E ÷ 預期成長率(%)；在我們的 CK 三步驟公式中，合理 P/E = 成長率% × PEG。

# 估值框架（從 config/peg-framework.md 載入，反映最新分析共識）

${framework}

# 任務
綜合「30 天新聞素材」、「AI 巨頭 capex 趨勢」、「公司基本面動能（cache-refresh 數據）」三類訊號，加上上面的估值框架，判斷每檔 PEG 是否需要月度調整。

特別注意：
- 五因子方法論是判斷主軸；每檔的 PEG 應該對應到框架第 2 節的「總分 → PEG 區間」映射
- 第 3 節給了個股具體錨點，可以直接對照
- 第 4 節是動能 heuristics，明確說明「成長下修 >3pp → PEG -0.1~0.2」這類規則
- 第 5 節風險清單若有觸發事件，要反映到 PEG 上

# AI 巨頭 capex 趨勢 (sector context)
${capexBlock}

# 各 ticker 素材
${tickerBlocks}

# 重要規則 (硬約束)
1. 變動上限: 任一檔的新 PEG 與當前差距不可超過 ±${maxChange}。
2. 絕對範圍: 新 PEG 必須在 [${floor}, ${ceiling}] 之間。
3. 若 30 天內沒有實質改變敘事的新聞 (例如：新產品線、客戶結構變化、競爭格局重大事件、capex 顯著加速/減速)，請保持當前值不變 (peg = 當前值, confidence 也照常給)。
4. confidence 是你對「這個 PEG 是當下合理值」的把握度 (0.0-1.0)。新聞無明顯訊號時應給 0.5-0.7；有強訊號時 0.8+。

# 輸出格式 (嚴格 JSON，不要 markdown 包裹)
{
  "NVDA": { "peg": 2.0, "reason": "繁中 1-2 句 ≤80 字", "confidence": 0.85 },
  "AMD": { ... },
  ...每檔都要有，總數必須等於本次 ticker 數 (${tickers.length})
}`;
}

// -- Apply LLM recommendations with safety filter --------------------------

function applyRecommendations(tickers, recommendations, globals, today) {
  const maxChange = globals.pegReview?.maxMonthlyChange ?? 0.3;
  const minConfidence = globals.pegReview?.minConfidence ?? 0.7;
  const floor = globals.pegReview?.absoluteFloor ?? 1.0;
  const ceiling = globals.pegReview?.absoluteCeiling ?? 2.5;

  const changes = [];
  const skipped = [];

  for (const t of tickers) {
    const rec = recommendations[t.symbol];
    if (!rec || !Number.isFinite(rec.peg)) {
      skipped.push({ symbol: t.symbol, reason: 'LLM 未提供建議' });
      continue;
    }
    const newPeg = Number(rec.peg.toFixed(2));
    const oldPeg = t.pegOverride;
    const delta  = newPeg - oldPeg;
    const reason = (rec.reason || '').trim();
    const conf   = Number(rec.confidence) || 0;

    // Hard bounds
    if (newPeg < floor || newPeg > ceiling) {
      skipped.push({ symbol: t.symbol, reason: `超出絕對範圍 [${floor},${ceiling}]: ${newPeg}` });
      continue;
    }
    // Cap monthly change
    if (Math.abs(delta) > maxChange) {
      skipped.push({ symbol: t.symbol, reason: `變動 ${delta.toFixed(2)} 超過上限 ±${maxChange}` });
      continue;
    }
    // No-op
    if (Math.abs(delta) < 0.05) continue;
    // Low confidence
    if (conf < minConfidence) {
      skipped.push({ symbol: t.symbol, reason: `信心 ${conf.toFixed(2)} < ${minConfidence}` });
      continue;
    }

    // Apply
    t.pegOverride = newPeg;
    t.pegLastChange = today;
    t.pegRationale = reason;
    t.analysisAssumptions = t.analysisAssumptions || {};
    t.analysisAssumptions.pegMultiplier = newPeg;
    t.analysisAssumptions.asOf = today;
    t.analysisAssumptions.source = 'monthly PEG review';
    t.pegHistory = Array.isArray(t.pegHistory) ? t.pegHistory : [];
    t.pegHistory.push({ date: today, peg: newPeg, reason });
    // Keep last 24 entries (2 years of monthly history).
    if (t.pegHistory.length > 24) t.pegHistory = t.pegHistory.slice(-24);
    changes.push({ symbol: t.symbol, oldPeg, newPeg, reason, conf });
  }

  return { changes, skipped };
}

// -- Telegram --------------------------------------------------------------

async function sendTelegram(text, parseMode) {
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  for (const { label, chatId } of destinations) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const err = await res.text();
        console.warn(`[${label}] sendMessage failed: ${err.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[${label}] sendMessage threw: ${err.message}`);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -- Resilient JSON parsing ------------------------------------------------
// The LLM occasionally returns JSON that is truncated (max_tokens hit) or
// wrapped in markdown despite json mode. A hard failure here throws away the
// whole month's review even when most tickers parsed fine. So: try a strict
// parse first, then fall back to salvaging every complete `"SYMBOL": { … }`
// entry via regex. applyRecommendations already skips any missing ticker, so
// a partial object still produces a useful (if smaller) review.
function parseRecommendations(raw) {
  // Strip any markdown fences in case the model added them despite json mode.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return { recommendations: JSON.parse(cleaned), partial: false };
  } catch (strictErr) {
    // Salvage complete top-level entries. Each value object is flat (no nested
    // braces), so a non-greedy `{…}` match is safe. Symbols may contain a dot
    // (e.g. BHP.AX). A truncated trailing entry simply won't match and is
    // dropped, which is exactly what we want.
    const entryRe = /"([A-Za-z0-9.]+)"\s*:\s*(\{[^{}]*\})/g;
    const salvaged = {};
    let count = 0;
    for (const m of cleaned.matchAll(entryRe)) {
      try {
        salvaged[m[1]] = JSON.parse(m[2]);
        count++;
      } catch { /* skip an entry that itself is malformed */ }
    }
    if (count === 0) throw strictErr;  // nothing recoverable — real failure
    console.warn(`JSON parse failed (${strictErr.message}); salvaged ${count} complete ticker entr${count === 1 ? 'y' : 'ies'}.`);
    return { recommendations: salvaged, partial: true };
  }
}

// -- Main ------------------------------------------------------------------

async function main() {
  const stockCfg = JSON.parse(await readFile(STOCK_CFG_PATH, 'utf-8'));
  const macroCfg = JSON.parse(await readFile(MACRO_CFG_PATH, 'utf-8'));
  const today    = new Date().toISOString().slice(0, 10);

  console.log(`Fetching 30d news for ${stockCfg.tickers.length} tickers...`);
  const newsResults = await Promise.allSettled(stockCfg.tickers.map(fetchTickerNews));
  const newsByTicker = Object.fromEntries(
    newsResults.map((r, i) => [stockCfg.tickers[i].symbol, r.status === 'fulfilled' ? r.value : []]),
  );
  const totalHeadlines = Object.values(newsByTicker).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`  collected ${totalHeadlines} headlines across ${stockCfg.tickers.length} tickers`);

  console.log('Fetching AI capex context from SEC EDGAR...');
  const capexBlock = await fetchCapexContext(macroCfg);

  console.log('Loading PEG framework from config/peg-framework.md...');
  // Editable: when analysis evolves (v6 → v7 → ...), just edit the file.
  // Prompt picks up the latest framework automatically next monthly run.
  const framework = await readFile(FRAMEWORK_PATH, 'utf-8');

  console.log('Calling LLM for PEG recommendations (Agnes → DeepSeek JSON mode)...');
  const prompt = buildPrompt({
    tickers: stockCfg.tickers,
    newsByTicker,
    capexBlock,
    globals: stockCfg.globals,
    framework,
  });
  let raw;
  try {
    raw = await callLLMReliable(prompt, {
      // ~19 tickers × a Traditional-Chinese `reason` (≤80 chars, ~2 tokens/char)
      // plus JSON scaffolding needs well over 3k tokens; the old 3000 cap
      // truncated the response mid-string. Give ample headroom.
      maxTokens: 8000,
      minContentLength: 50,
      responseFormat: 'json',
    });
  } catch (err) {
    console.error('LLM call failed:', err.message);
    await sendTelegram(`⚠️ PEG 月度檢視失敗：LLM 不可用\n${err.message}`, undefined);
    process.exit(1);
  }

  let recommendations;
  try {
    ({ recommendations } = parseRecommendations(raw));
  } catch (err) {
    console.error('Failed to parse LLM JSON:', err.message);
    console.error('Raw response (first 1000 chars):', raw.slice(0, 1000));
    await sendTelegram(`⚠️ PEG 月度檢視失敗：LLM 回傳非 JSON\n${err.message}`, undefined);
    process.exit(1);
  }

  const { changes, skipped } = applyRecommendations(
    stockCfg.tickers, recommendations, stockCfg.globals, today,
  );

  // Write back even if no changes — pegHistory is unaffected and JSON is
  // stable; the workflow step skips commit when git diff is empty.
  await writeFile(STOCK_CFG_PATH, JSON.stringify(stockCfg, null, 2) + '\n', 'utf-8');
  console.log(`Applied ${changes.length} change(s), skipped ${skipped.length}`);

  // -- Compose Telegram summary -----------------------------------------
  const monthLabel = today.slice(0, 7);  // YYYY-MM
  const parts = [`📐 <b>PEG 月度檢視 ${monthLabel}</b>`];

  if (changes.length === 0) {
    parts.push('本月所有 ticker 維持原 PEG（無新聞或變化未達門檻）。');
  } else {
    parts.push(`<b>調整 ${changes.length} 檔：</b>`);
    for (const c of changes) {
      const arrow = c.newPeg > c.oldPeg ? '↑' : '↓';
      parts.push(`• ${escapeHtml(c.symbol)}　${c.oldPeg} ${arrow} <b>${c.newPeg}</b>  (信心 ${c.conf.toFixed(2)})\n  <i>${escapeHtml(c.reason)}</i>`);
    }
  }

  if (skipped.length > 0) {
    parts.push(`<b>未調整 ${skipped.length} 檔</b>（安全閥）：${skipped.map(s => escapeHtml(s.symbol)).join('、')}`);
  }

  parts.push('');
  parts.push('<i>下次跑 Daily Stock Digest 即套用新 PEG；卡片底會顯示 3 天的變更說明。</i>');

  await sendTelegram(parts.join('\n\n'), 'HTML');
  console.log('Telegram summary sent.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
