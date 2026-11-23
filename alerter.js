/*
 * Forex V1.4 cloud alerter: runs once per call (GitHub Actions), checks the markets in config.json,
 * and sends new signals / exits / news alerts to Telegram. Same engine and defaults as the Signal Monitor.
 *
 * Secrets (GitHub → Settings → Secrets and variables → Actions):
 *   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 * Test switches (local use only): MOCK_DATA=<json file>, MOCK_NOW=<epoch seconds>, MOCK_NEWS=<json file>, DRY_RUN=1
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { Engine14 } = require("./engine14.js");

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const STATE_FILE = path.join(DIR, "state.json");
const TF = { "15m": 900, "30m": 1800, "1H": 3600, "4H": 14400 };
const now = () => (process.env.MOCK_NOW ? +process.env.MOCK_NOW : Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtT = t => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- state
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return { markets: {}, newsSent: [], spikes: {} }; }
}
function saveState(st) {
  st.newsSent = (st.newsSent || []).slice(-300);
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
}

// ---------------------------------------------------------------- Deriv data
const ENDPOINTS = ["wss://api.derivws.com/trading/v1/options/ws/public", "wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089",
                   "wss://ws.derivws.com/websockets/v3?app_id=1089"];
let WS = null;
function openOne(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch (e) {} rej(new Error("timeout")); } }, 15000);
    ws.onopen = () => { if (!done) { done = true; clearTimeout(t); res(ws); } };
    ws.onerror = () => { if (!done) { done = true; clearTimeout(t); rej(new Error("refused")); } };
  });
}
async function getWS() {
  if (WS && WS.readyState === 1) return WS;
  for (const u of ENDPOINTS) { try { WS = await openOne(u); log("connected", u.split("?")[0]); return WS; } catch (e) { log("connect failed", u.split("?")[0], e.message); } }
  throw new Error("could not connect to Deriv");
}
async function ask(req) {
  const ws = await getWS();
  return new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9); req.req_id = id;
    const t = setTimeout(() => { ws.removeEventListener("message", h); rej(new Error("no reply")); }, 45000);
    const h = ev => { const r = JSON.parse(ev.data); if (r.req_id !== id) return; clearTimeout(t); ws.removeEventListener("message", h); r.error ? rej(new Error(r.error.message)) : res(r); };
    ws.addEventListener("message", h); ws.send(JSON.stringify(req));
  });
}
let MOCK = null;
async function candles(sym, gran, count, end) {
  const e = Math.floor(end || now());
  if (process.env.MOCK_DATA) {
    MOCK = MOCK || JSON.parse(fs.readFileSync(process.env.MOCK_DATA, "utf8"));
    const rows = (MOCK[sym + "_" + gran] || []).filter(r => r.time <= e && r.time >= e - count * gran * 1.7);
    return rows.slice(-count).map(r => ({ ...r }));
  }
  for (let k = 0; k < 4; k++) {
    try {
      const r = await ask({ ticks_history: sym, style: "candles", granularity: gran, start: Math.floor(e - count * gran * 1.7), end: e, count });
      return (r.candles || []).map(c => ({ time: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    } catch (err) { log(sym, "history error:", err.message); if (/rate limit/i.test(err.message)) await sleep(20000); else { WS = null; await sleep(3000); } }
  }
  throw new Error("history unavailable for " + sym);
}

// ---------------------------------------------------------------- Telegram
const OUTBOX = [];
async function telegram(text) {
  OUTBOX.push(text);
  if (process.env.DRY_RUN) { console.log("\n=== TELEGRAM ===\n" + text + "\n================"); return; }
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log("Telegram secrets missing; message not sent:", text.slice(0, 80)); return; }
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
      if (r.ok) return;
      log("Telegram HTTP", r.status, await r.text());
    } catch (e) { log("Telegram error", e.message); }
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- news (same explanations as the Signal Monitor)
const SPIKE_STATS = { frxXAUUSD: { n: 433, cont: 51.9, bigN: 125, bigCont: 50.8 }, frxEURUSD: { n: 273, cont: 50.9, bigN: 72, bigCont: 39.4 },
                      frxGBPUSD: { n: 222, cont: 44.5, bigN: 57, bigCont: 38.6 }, frxUSDJPY: { n: 519, cont: 48.5, bigN: 170, bigCont: 49.7 } };
function currenciesOf(sym) {
  if (!sym.startsWith("frx")) return [];
  const p = sym.slice(3), out = new Set([p.slice(0, 3), p.slice(3, 6)]);
  if (out.has("XAU") || out.has("XAG")) out.add("USD");
  out.delete("XAU"); out.delete("XAG"); return [...out];
}
function numOf(v) {
  if (!v) return NaN; const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/); if (!m) return NaN;
  let x = parseFloat(m[0]); const u = String(v).trim().slice(-1).toUpperCase();
  if (u === "K") x *= 1e3; else if (u === "M") x *= 1e6; else if (u === "B") x *= 1e9; else if (u === "T") x *= 1e12; return x;
}
function eventKind(title) {
  const t = title.toLowerCase();
  if (/speaks|speech|testif|press conference|statement|minutes|meeting|summit|hearing/.test(t)) return "talk";
  if (/unemployment|jobless|claimant/.test(t)) return "inverse";
  return "normal";
}
function pairEffect(sym, cur, curUp) {
  const p = sym.slice(3), base = p.slice(0, 3), quote = p.slice(3, 6);
  if (base === "XAU" || base === "XAG") return cur === "USD" ? (curUp ? "DOWN" : "UP") : null;
  if (cur === base) return curUp ? "UP" : "DOWN";
  if (cur === quote) return curUp ? "DOWN" : "UP";
  return null;
}
const nameOf = sym => (CFG.markets.find(m => m.symbol === sym) || {}).name || sym;
function explainEvent(ev, syms) {
  const kind = eventKind(ev.title), f = numOf(ev.forecast), pv = numOf(ev.previous);
  const affected = syms.filter(s => pairEffect(s, ev.cur, true)); const lines = [];
  const fx = strong => affected.length ? " → " + affected.map(s => `${nameOf(s)} likely ${pairEffect(s, ev.cur, strong)}`).join(", ") : "";
  if (kind === "talk" || isNaN(f)) {
    lines.push(`No number is released. A "hawkish" tone (inflation worries, higher rates) usually strengthens ${ev.cur}; a "dovish" tone usually weakens it.`);
    if (affected.length) lines.push(`• Hawkish${fx(true)}`, `• Dovish${fx(false)}`);
    return lines;
  }
  const dir = isNaN(pv) ? "" : f > pv ? "higher than" : f < pv ? "lower than" : "the same as";
  const why = kind === "inverse" ? "For this release a HIGHER number means a weaker economy."
            : /rate|bank|refinancing/i.test(ev.title) ? "A HIGHER number means higher interest rates, which usually support the currency."
            : "A HIGHER number usually means a stronger economy or more inflation pressure, which usually supports the currency.";
  lines.push(`Forecast ${ev.forecast} vs previous ${ev.previous || "n/a"}: economists expect it ${dir ? dir + " last time" : "at " + ev.forecast}. ${why}`);
  lines.push("What moves price is the ACTUAL compared with the FORECAST:");
  const upAbove = kind !== "inverse";
  lines.push(`• Actual ABOVE ${ev.forecast} → ${ev.cur} ${upAbove ? "stronger" : "weaker"}${fx(upAbove)}`);
  lines.push(`• Actual BELOW ${ev.forecast} → ${ev.cur} ${upAbove ? "weaker" : "stronger"}${fx(!upAbove)}`);
  lines.push(`• Actual ≈ ${ev.forecast} → usually a small reaction`);
  return lines;
}
async function loadNews() {
  try {
    let data;
    if (process.env.MOCK_NEWS) data = JSON.parse(fs.readFileSync(process.env.MOCK_NEWS, "utf8"));
    else { const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json"); if (!r.ok) throw new Error("HTTP " + r.status); data = await r.json(); }
    return data.filter(e => String(e.impact).toLowerCase() === "high")
               .map(e => ({ t: Date.parse(e.date) / 1000, cur: e.country, title: e.title, forecast: (e.forecast || "").trim(), previous: (e.previous || "").trim() }))
               .filter(e => isFinite(e.t));
  } catch (e) { log("news calendar unavailable:", e.message); return []; }
}

// ---------------------------------------------------------------- per-market engine (same defaults as the Signal Monitor)
function engineFor(sym, gran, mintick) {
  const isFX = sym.startsWith("frx");
  return new Engine14({
    profile: isFX ? "Forex" : "Synthetic", reward: CFG.targetR || 1, mintick, fxSpreadPips: CFG.forexSpreadPips || 1.5,
    trendEMA: 200, trendSec: gran >= 14400 ? 86400 : 14400,
    touchMode: isFX ? "50% midpoint" : "Any touch",
    useHTF: sym === "frxXAUUSD" && gran < 3600, htfSec: 14400,
  });
}
function decimalsOf(rows) { let d = 0; for (const r of rows.slice(-200)) for (const v of [r.open, r.high, r.low, r.close]) { const s = String(v); d = Math.max(d, s.includes(".") ? s.split(".")[1].length : 0); } return d; }

async function runMarket(mk, st, news) {
  const gran = TF[mk.timeframe] || 900, sym = mk.symbol, key = sym + "_" + gran;
  // wait until the candle that just ended is final (5 s grace)
  const nt = now(), lastClose = Math.floor(nt / gran) * gran;
  if (!process.env.MOCK_NOW && nt - lastClose < 5) await sleep((5 - (nt - lastClose)) * 1000);
  let rows = await candles(sym, gran, 1000);
  if (rows.length) { const older = await candles(sym, gran, 1000, rows[0].time - 1); rows = older.concat(rows); }
  const seen = new Set(); rows = rows.filter(r => !seen.has(r.time) && seen.add(r.time)).sort((a, b) => a.time - b.time);
  const forming = rows.length && rows[rows.length - 1].time + gran > now() ? rows[rows.length - 1] : null;
  const closed = rows.filter(r => r.time + gran <= now());
  if (!closed.length) { log(sym, "no data"); return; }
  const dec = decimalsOf(closed), eng = engineFor(sym, gran, Math.pow(10, -dec));
  const ms = st.markets[key] || {};
  const firstRun = !ms.lastBar;
  const events = [];
  for (const b of closed) { const r = eng.push(b); if (!firstRun && b.time > ms.lastBar) events.push({ bar: b, r }); }
  const last = closed[closed.length - 1];
  const price = forming ? forming.close : last.close;
  const tfName = mk.timeframe, nm = mk.name || sym;
  if (firstRun) {
    log(nm, `first run: engine ready on ${closed.length} closed candles; alerts start from the next candle.`);
    await telegram(`✅ Forex V1.4 cloud alerter is running for ${nm} ${tfName}.\nYou'll get a message for every new trade signal, stop/target hit and high-impact news event. (Engine: 200 EMA on, ${sym.startsWith("frx") ? "50% midpoint" : "any-touch"} FVG entry${sym === "frxXAUUSD" && gran < 3600 ? ", 4H structure filter on" : ""}.)`);
  }
  let missed = 0;
  for (const { bar, r } of events) {
    const ago = Math.round((now() - (bar.time + gran)) / 60);
    if (ago > 90 && r.signal && (r.taken || CFG.alertEverySignal)) { missed++; continue; }   // too old to act on
    if (r.exit) {
      await telegram(`${r.exit.reason === "target" ? "✅" : r.exit.reason === "stop" ? "❌" : "ℹ️"} ${nm} ${tfName} ${r.exit.long ? "BUY" : "SELL"} closed: ${r.exit.reason === "target" ? "TARGET hit" : r.exit.reason === "stop" ? "STOP hit" : r.exit.reason} at ${(+r.exit.price).toFixed(dec)} (candle ${fmtT(bar.time)} UTC)`);
    }
    if (r.signal && (r.taken || CFG.alertEverySignal)) {
      const s = r.signal, sgn = s.side === "BUY" ? 1 : -1;
      const moveR = sgn * (price - s.entry) / s.risk;
      const late = ago > 20 ? "⏰ Alert delayed: check the chart before entering." : "";
      const verdict = Math.abs(moveR) <= (CFG.lateEntryMaxR || 0.25) ? `✅ OK to enter (price is ${moveR >= 0 ? "+" : ""}${moveR.toFixed(2)}R from entry)`
                    : moveR > 0 ? `⚠️ Price already ran ${moveR.toFixed(2)}R toward target: too late, skip or wait for a retest`
                    : `⚠️ Price is ${moveR.toFixed(2)}R toward the stop: skip`;
      const spike = st.spikes[sym] && s.time >= st.spikes[sym].t && s.time <= st.spikes[sym].t + 7200 ? ((s.side === "BUY") === (st.spikes[sym].dir > 0) ? "\nWith the recent news spike." : "\nAgainst the recent news spike.") : "";
      const nearNews = (news || []).find(e => currenciesOf(sym).includes(e.cur) && Math.abs(e.t - now()) <= (CFG.news.warnWindowMinutes || 30) * 60);
      const warn = nearNews ? `\n⚠️ High-impact news: ${nearNews.cur} ${nearNews.title} at ${fmtT(nearNews.t).slice(11)} UTC` : "";
      await telegram(`🔔 ${nm} ${tfName} ${s.side}${r.taken ? "" : " (signal only, a trade is already open)"}\n` +
        `Entry ${s.entry.toFixed(dec)} | SL ${s.stop.toFixed(dec)} | TP ${s.target.toFixed(dec)}\n` +
        `Candle closed ${fmtT(bar.time + gran)} UTC (${ago} min ago). Price now ${price.toFixed(dec)}.\n${verdict}${late ? "\n" + late : ""}${spike}${warn}`);
    }
  }
  if (missed) await telegram(`ℹ️ ${nm} ${tfName}: ${missed} signal(s) happened while the alerter was offline for a while (older than 90 min, so not sent). Check the chart.`);
  st.markets[key] = { lastBar: last.time, updated: Math.floor(now()), open: eng.pos ? { side: eng.pos.long ? "BUY" : "SELL", stop: eng.pos.stop, target: eng.pos.target } : null };
  log(nm, `checked up to candle ${fmtT(last.time)} UTC; ${events.length} new candle(s); ${eng.pos ? "virtual trade open" : "flat"}.`);
}

async function runNews(st, news) {
  if (!CFG.news || !CFG.news.enabled || !news.length) return;
  const syms = CFG.markets.map(m => m.symbol).filter(s => s.startsWith("frx"));
  const lead = (CFG.news.minutesBefore || 15) * 60, t = now();
  st.newsSent = st.newsSent || [];
  for (const ev of news) {
    const rel = syms.filter(s => currenciesOf(s).includes(ev.cur)); if (!rel.length) continue;
    const id = ev.cur + "|" + ev.title + "|" + ev.t;
    if (!st.newsSent.includes("pre|" + id) && t >= ev.t - lead - 60 && t < ev.t) {
      st.newsSent.push("pre|" + id);
      await telegram(`📅 In ${Math.max(1, Math.round((ev.t - t) / 60))} min: ${ev.cur} ${ev.title} (${fmtT(ev.t).slice(11)} UTC)\n` + explainEvent(ev, rel).join("\n") +
                     "\nThe first move happens within seconds of the release; after the spike candle, direction has been close to 50/50 in testing.");
    }
    const slot = Math.floor(ev.t / 900) * 900;
    if (CFG.news.postNewsReport && !st.newsSent.includes("post|" + id) && t >= slot + 900 + 5 && t < ev.t + 3 * 3600) {
      st.newsSent.push("post|" + id);
      for (const s of rel) {
        try {
          const rows = (await candles(s, 900, 120, slot + 900 * 2)).sort((a, b) => a.time - b.time);
          const k = rows.findIndex(r => r.time === slot); if (k < 20) continue;
          const prev = rows.slice(Math.max(0, k - 96), k).map(r => r.high - r.low).sort((a, b) => a - b);
          const c = rows[k], size = (c.high - c.low) / prev[Math.floor(prev.length / 2)], d = c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
          if (size >= 2 && d) st.spikes[s] = { t: slot + 900, dir: d };
          const stt = SPIKE_STATS[s], big = size >= 5 && stt, n = big ? stt.bigN : stt && stt.n, cont = big ? stt.bigCont : stt && stt.cont;
          const hist = stt ? `Historically (${n} ${big ? "very large " : ""}spikes on ${nameOf(s)}), price kept going the same way over the next hour ${cont.toFixed(0)}% of the time: ${Math.abs(cont - 50) < 5 ? "no reliable edge either way." : `a ${cont < 50 ? "pull-back" : "follow-through"} tendency, not proven.`}`
                           : "Treat the next move as 50/50.";
          await telegram(`📊 After ${ev.cur} ${ev.title}: ${nameOf(s)} moved ${d > 0 ? "UP" : d < 0 ? "DOWN" : "flat"} ${size.toFixed(1)}× its normal 15-min range${size >= 2 ? " (news spike)" : " (small reaction)"}. ${hist}`);
        } catch (e) { log("post-news report failed:", e.message); }
      }
    }
  }
}

(async () => {
  const st = loadState(); st.spikes = st.spikes || {};
  const news = CFG.news && CFG.news.enabled ? await loadNews() : [];
  for (const mk of CFG.markets) {
    try { await runMarket(mk, st, news); } catch (e) { log(mk.symbol, "failed:", e.message); }
  }
  try { await runNews(st, news); } catch (e) { log("news failed:", e.message); }
  st.lastRun = Math.floor(now());
  saveState(st);
  try { if (WS) WS.close(); } catch (e) {}
  log(`done; ${OUTBOX.length} Telegram message(s).`);
  process.exit(0);
})();
