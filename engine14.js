/*
 * SMC + FVG Forex V1.4 signal engine (JavaScript, incremental, one bar at a time).
 * Mirrors smc14.py / SMC_FVG_Forex_V1_4.pine. Used by the Signal Monitor page and by
 * node validation scripts. No dependencies.
 */
(function (root) {
  "use strict";
  const DEFAULTS = {
    swingLen: 5, internalLen: 2, structure: "Both", requireDir: true, structureAge: 48,
    minGapPct: 0, fvgLife: 80, mitigation: "Close through", touchMode: "50% midpoint", maxZones: 30,
    useOB: false, obLookback: 12, obLife: 80, useFVG: true, useConfluence: false,
    confirmType: "Rejection close", requireBarColor: true, cooldown: 1, allowSameZone: false,
    profile: "Synthetic", reward: 1.0, atrLen: 14, minGapATR: 0.1, stopBufATR: 0.1, minStopATR: 0.5,
    tightMode: "Widen to minimum", maxStopATR: 3.0, synthCostPct: 0.05, fxSpreadPips: 1.5, maxCostR: 0.2,
    useHTF: false, htfSec: 14400, keepZoneWhenBusy: true, useSession: true, sessionStart: 420, sessionEnd: 1200,
    fridayCutoff: 19, flatFriday: true, resetAfterGap: true, useRoom: false, mintick: 0.01,
    trendEMA: 0, trendSec: 14400,
  };

  function pivotAt(arr, L, R, isHigh) {
    // arr is the full history; detect pivot whose centre is arr.length-1-R
    const j = arr.length - 1, c = j - R;
    if (c - L < 0) return NaN;
    const v = arr[c];
    for (let k = c - L; k < c; k++) if (isHigh ? !(v > arr[k]) : !(v < arr[k])) return NaN;
    for (let k = c + 1; k <= j; k++) if (isHigh ? !(v >= arr[k]) : !(v <= arr[k])) return NaN;
    return v;
  }

  class Engine14 {
    constructor(opts) {
      this.s = Object.assign({}, DEFAULTS, opts || {});
      this.s.isFX = this.s.profile === "Forex";
      this.T = []; this.O = []; this.H = []; this.L = []; this.C = [];
      this.atrSum = 0; this.atrCnt = 0; this.atr = NaN;
      this.swingHigh = NaN; this.swingLow = NaN; this.intHigh = NaN; this.intLow = NaN;
      this.sHB = null; this.sLB = null; this.iHB = null; this.iLB = null;
      this.bSH = null; this.bSL = null; this.bIH = null; this.bIL = null;
      this.lastDirection = 0; this.lastBull = null; this.lastBear = null;
      this.fvgs = []; this.obs = []; this.zid = 0; this.lastSignalBar = null;
      this.pos = null; this.barSec = null;
      // HTF state
      this.htfKey = null; this.htfCur = null; this.HH = []; this.HL = []; this.HC = [];
      this.htfLastH = NaN; this.htfLastL = NaN; this.htfD = 0; this.htfDirPrev = 0;
      // 200 EMA trend state (previous completed trend-timeframe bar)
      this.tKey = null; this.tClose = NaN; this.tEma = NaN; this.trendPrev = 0;
      // daily state
      this.dayKey = null; this.dayH = NaN; this.dayL = NaN; this.pdh = NaN; this.pdl = NaN;
    }

    _updateHTF(t, h, l, c) {
      const s = this.s, key = Math.floor(t / s.htfSec);
      if (this.htfKey === null) { this.htfKey = key; this.htfCur = { h, l, c }; return; }
      if (key !== this.htfKey) {
        // finalise the completed HTF bar
        this.HH.push(this.htfCur.h); this.HL.push(this.htfCur.l); this.HC.push(this.htfCur.c);
        const hp = pivotAt(this.HH, s.swingLen, s.swingLen, true), lp = pivotAt(this.HL, s.swingLen, s.swingLen, false);
        if (!isNaN(hp)) this.htfLastH = hp;
        if (!isNaN(lp)) this.htfLastL = lp;
        const hc = this.htfCur.c;
        if (!isNaN(this.htfLastH) && hc > this.htfLastH) this.htfD = 1;
        if (!isNaN(this.htfLastL) && hc < this.htfLastL) this.htfD = -1;
        this.htfDirPrev = this.htfD;
        this.htfKey = key; this.htfCur = { h, l, c };
      } else {
        this.htfCur.h = Math.max(this.htfCur.h, h); this.htfCur.l = Math.min(this.htfCur.l, l); this.htfCur.c = c;
      }
    }

    _updateTrend(t, c) {
      const s = this.s, key = Math.floor(t / s.trendSec);
      if (this.tKey === null) { this.tKey = key; this.tClose = c; return; }
      if (key !== this.tKey) {
        const a = 2 / (s.trendEMA + 1);
        this.tEma = isNaN(this.tEma) ? this.tClose : a * this.tClose + (1 - a) * this.tEma;
        this.trendPrev = this.tClose > this.tEma ? 1 : this.tClose < this.tEma ? -1 : 0;
        this.tKey = key;
      }
      this.tClose = c;
    }

    _updateDay(t, h, l) {
      const key = Math.floor(t / 86400);
      if (this.dayKey === null) { this.dayKey = key; this.dayH = h; this.dayL = l; return; }
      if (key !== this.dayKey) { this.pdh = this.dayH; this.pdl = this.dayL; this.dayKey = key; this.dayH = h; this.dayL = l; }
      else { this.dayH = Math.max(this.dayH, h); this.dayL = Math.min(this.dayL, l); }
    }

    /* Push one CLOSED bar {time (s, bar open), open, high, low, close}.
       Returns { signal: null|{...}, taken: bool, exit: null|{...} } */
    push(bar) {
      const s = this.s, T = this.T, O = this.O, H = this.H, L = this.L, C = this.C;
      const t = bar.time, o = +bar.open, h = +bar.high, l = +bar.low, c = +bar.close;
      const i = C.length;
      if (i >= 1 && this.barSec === null) this.barSec = t - T[i - 1];
      if (i >= 1 && this.barSec !== null) this.barSec = Math.min(this.barSec, t - T[i - 1]);
      T.push(t); O.push(o); H.push(h); L.push(l); C.push(c);
      const out = { signal: null, taken: false, exit: null, bar: i };
      // ATR (RMA)
      const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - C[i - 1]), Math.abs(l - C[i - 1]));
      if (this.atrCnt < s.atrLen) { this.atrSum += tr; this.atrCnt++; if (this.atrCnt === s.atrLen) this.atr = this.atrSum / s.atrLen; }
      else this.atr = (this.atr * (s.atrLen - 1) + tr) / s.atrLen;
      const A = this.atr;
      if (s.useHTF) this._updateHTF(t, h, l, c);
      if (s.trendEMA > 0) this._updateTrend(t, c);
      if (s.isFX && s.useRoom) this._updateDay(t, h, l);
      const barSec = this.barSec || 900;

      // broker exit
      const pos = this.pos;
      if (pos && i > pos.bar) {
        let hit = null;
        if (pos.long) { if (o <= pos.stop) hit = ["stop", o]; else if (o >= pos.target) hit = ["limit", o]; }
        else { if (o >= pos.stop) hit = ["stop", o]; else if (o <= pos.target) hit = ["limit", o]; }
        if (!hit) {
          const highFirst = (h - o) < (o - l);
          for (const leg of (highFirst ? ["h", "l"] : ["l", "h"])) {
            if (leg === "h") {
              if (pos.long && h >= pos.target) { hit = ["limit", pos.target]; break; }
              if (!pos.long && h >= pos.stop) { hit = ["stop", pos.stop]; break; }
            } else {
              if (pos.long && l <= pos.stop) { hit = ["stop", pos.stop]; break; }
              if (!pos.long && l <= pos.target) { hit = ["limit", pos.target]; break; }
            }
          }
        }
        if (hit) { out.exit = { reason: hit[0] === "limit" ? "target" : "stop", price: hit[1], long: pos.long, entryTime: pos.time }; this.pos = null; }
      }

      const marketGap = i > 0 && (t - T[i - 1]) > Math.max(6 * 3600, 3 * barSec);
      if (s.isFX && s.resetAfterGap && marketGap) { this.fvgs = []; this.obs = []; }

      // structure
      const phS = pivotAt(H, s.swingLen, s.swingLen, true), plS = pivotAt(L, s.swingLen, s.swingLen, false);
      const phI = pivotAt(H, s.internalLen, s.internalLen, true), plI = pivotAt(L, s.internalLen, s.internalLen, false);
      if (!isNaN(phS)) { this.swingHigh = phS; this.sHB = i - s.swingLen; }
      if (!isNaN(plS)) { this.swingLow = plS; this.sLB = i - s.swingLen; }
      if (!isNaN(phI)) { this.intHigh = phI; this.iHB = i - s.internalLen; }
      if (!isNaN(plI)) { this.intLow = plI; this.iLB = i - s.internalLen; }
      let sUp = false, sDn = false, iUp = false, iDn = false;
      if (!isNaN(this.swingHigh) && c > this.swingHigh && (this.bSH === null || this.bSH !== this.sHB)) { sUp = true; this.bSH = this.sHB; }
      if (!isNaN(this.swingLow) && c < this.swingLow && (this.bSL === null || this.bSL !== this.sLB)) { sDn = true; this.bSL = this.sLB; }
      if (!isNaN(this.intHigh) && c > this.intHigh && (this.bIH === null || this.bIH !== this.iHB)) { iUp = true; this.bIH = this.iHB; }
      if (!isNaN(this.intLow) && c < this.intLow && (this.bIL === null || this.bIL !== this.iLB)) { iDn = true; this.bIL = this.iLB; }
      const useS = s.structure === "Swing" || s.structure === "Both", useI = s.structure === "Internal" || s.structure === "Both";
      const bullEvent = (useS && sUp) || (useI && iUp), bearEvent = (useS && sDn) || (useI && iDn);
      if (bullEvent) { this.lastBull = i; this.lastDirection = 1; }
      if (bearEvent) { this.lastBear = i; this.lastDirection = -1; }

      if (s.useOB && (bullEvent || bearEvent)) {
        const d = bullEvent ? 1 : -1; let cand = null;
        for (let back = 1; back <= s.obLookback; back++) {
          if (i - back < 0) break;
          if (cand === null && (d === 1 ? C[i - back] < O[i - back] : C[i - back] > O[i - back])) cand = back;
        }
        if (cand !== null) this.obs.push({ id: ++this.zid, top: H[i - cand], bot: L[i - cand], dir: d, birth: i, used: false });
      }

      const contiguous = i >= 2 && (t - T[i - 2]) <= 2.5 * barSec;
      if (i >= 2 && contiguous) {
        const bigBull = isNaN(A) ? s.minGapATR === 0 : (l - H[i - 2]) >= s.minGapATR * A;
        const bigBear = isNaN(A) ? s.minGapATR === 0 : (L[i - 2] - h) >= s.minGapATR * A;
        const nb = l > H[i - 2] && (l - H[i - 2]) / c * 100 >= s.minGapPct && bigBull;
        const nr = h < L[i - 2] && (L[i - 2] - h) / c * 100 >= s.minGapPct && bigBear;
        if (nb || nr) this.fvgs.push({ id: ++this.zid, top: nb ? l : L[i - 2], bot: nb ? H[i - 2] : h, dir: nb ? 1 : -1, birth: i, used: false });
      }

      let bullF = null, bearF = null, bullO = null, bearO = null;
      for (const z of this.fvgs.slice().reverse()) {
        const age = i - z.birth, top = z.top, bot = z.bot, d = z.dir;
        const invalid = s.mitigation === "Close through" ? (d === 1 ? c < bot : c > top) : (d === 1 ? l < bot : h > top);
        if (age > s.fvgLife || invalid) { this.fvgs.splice(this.fvgs.indexOf(z), 1); continue; }
        const mid = (top + bot) / 2;
        const depth = s.touchMode === "Any touch" ? (l <= top && h >= bot) : d === 1 ? (l <= mid && h >= bot) : (h >= mid && l <= top);
        const valid = age > 0 && depth && (s.allowSameZone || !z.used);
        const rej = s.confirmType === "Touch only" || (d === 1 ? c > mid : c < mid);
        if (valid && rej) { if (d === 1 && !bullF) bullF = z; if (d === -1 && !bearF) bearF = z; }
      }
      for (const z of this.obs.slice().reverse()) {
        const age = i - z.birth, top = z.top, bot = z.bot, d = z.dir;
        if (age > s.obLife || (d === 1 ? c < bot : c > top)) { this.obs.splice(this.obs.indexOf(z), 1); continue; }
        const touched = age > 0 && l <= top && h >= bot && (s.allowSameZone || !z.used);
        const rej = s.confirmType === "Touch only" || (d === 1 ? c > (top + bot) / 2 : c < (top + bot) / 2);
        if (touched && rej) { if (d === 1 && !bullO) bullO = z; if (d === -1 && !bearO) bearO = z; }
      }

      const recentBull = this.lastBull !== null && i - this.lastBull <= s.structureAge;
      const recentBear = this.lastBear !== null && i - this.lastBear <= s.structureAge;
      const bullBias = recentBull && (!s.requireDir || this.lastDirection === 1);
      const bearBias = recentBear && (!s.requireDir || this.lastDirection === -1);

      const dt = new Date(t * 1000), dow = dt.getUTCDay(), mod = dt.getUTCHours() * 60 + dt.getUTCMinutes(), hour = dt.getUTCHours();
      const sessOK = !s.isFX || !s.useSession || (mod >= s.sessionStart && mod < s.sessionEnd);
      const wkBlock = s.isFX && (dow === 6 || dow === 0 || (dow === 5 && hour >= s.fridayCutoff));
      const entryWindow = sessOK && !wkBlock;
      const htfBull = (!s.useHTF || this.htfDirPrev === 1) && (s.trendEMA === 0 || this.trendPrev === 1);
      const htfBear = (!s.useHTF || this.htfDirPrev === -1) && (s.trendEMA === 0 || this.trendPrev === -1);
      const buyC = bullBias && htfBull && ((s.useFVG && bullF && (!s.useConfluence || bullO)) || (s.useOB && bullO && (!s.useConfluence || bullF)));
      const sellC = bearBias && htfBear && ((s.useFVG && bearF && (!s.useConfluence || bearO)) || (s.useOB && bearO && (!s.useConfluence || bearF)));
      const bullCandle = !s.requireBarColor || c > o, bearCandle = !s.requireBarColor || c < o;

      const edge = (f, ob, lowSide) => {
        let e = NaN;
        if (s.useFVG && f) e = lowSide ? f.bot : f.top;
        if (s.useOB && ob) { const v = lowSide ? ob.bot : ob.top; e = isNaN(e) ? v : (lowSide ? Math.min(e, v) : Math.max(e, v)); }
        return e;
      };
      const a = isNaN(A) ? 0 : A;
      const costPrice = s.isFX ? s.fxSpreadPips * s.mintick * 10 : c * s.synthCostPct / 100;
      const buf = Math.max(s.mintick, a * s.stopBufATR);
      const plan = (isLong, e) => {
        if (isNaN(e)) return [NaN, NaN, false];
        let stop = isLong ? e - buf : e + buf, risk = isLong ? c - stop : stop - c;
        const minRisk = a * s.minStopATR;
        if (s.minStopATR > 0 && risk < minRisk && s.tightMode === "Widen to minimum") { stop = isLong ? c - minRisk : c + minRisk; risk = minRisk; }
        let ok = risk > s.mintick;
        ok = ok && (s.minStopATR === 0 || risk >= minRisk - s.mintick);
        ok = ok && (s.maxStopATR === 0 || isNaN(A) || risk <= s.maxStopATR * A);
        ok = ok && (s.maxCostR === 0 || costPrice <= s.maxCostR * risk);
        return [stop, risk, ok];
      };
      const [bStop, bRisk, bOK] = plan(true, edge(bullF, bullO, true));
      const [sStop, sRisk, sOK] = plan(false, edge(bearF, bearO, false));
      const useRoom = s.isFX && s.useRoom;
      const bRoom = !useRoom || isNaN(this.pdh) || this.pdh <= c || this.pdh >= c + s.reward * bRisk;
      const sRoom = !useRoom || isNaN(this.pdl) || this.pdl >= c || this.pdl <= c - s.reward * sRisk;
      const ready = this.lastSignalBar === null || i - this.lastSignalBar > s.cooldown;
      const buy = !!(ready && buyC && bullCandle && !sellC && entryWindow && bOK && bRoom);
      const sell = !!(ready && sellC && bearCandle && !buyC && entryWindow && sOK && sRoom);
      const flat = this.pos === null;
      const consume = flat || !s.keepZoneWhenBusy;
      if (buy || sell) this.lastSignalBar = i;
      if (buy && consume) { if (bullF) bullF.used = true; if (bullO) bullO.used = true; }
      if (sell && consume) { if (bearF) bearF.used = true; if (bearO) bearO.used = true; }

      const fxFlat = s.isFX && s.flatFriday && dow === 5 && mod >= 20 * 60 + 30;
      if (fxFlat && this.pos) { out.exit = { reason: "weekend close", price: c, long: this.pos.long, entryTime: this.pos.time }; this.pos = null; }
      if (buy || sell) {
        const long = buy, stop = long ? bStop : sStop, risk = long ? bRisk : sRisk;
        const target = c + (long ? 1 : -1) * s.reward * risk;
        out.signal = { time: t, side: long ? "BUY" : "SELL", entry: c, stop, target, risk, takenWhileFlat: flat };
        if (this.pos === null) {
          this.pos = { bar: i, time: t, long, stop, target };
          out.taken = true;
        }
      }
      while (this.fvgs.length > 2 * s.maxZones) this.fvgs.shift();
      while (this.obs.length > 60) this.obs.shift();
      return out;
    }
  }
  root.Engine14 = Engine14;
  root.ENGINE14_DEFAULTS = DEFAULTS;
  if (typeof module !== "undefined") module.exports = { Engine14, DEFAULTS };
})(typeof window !== "undefined" ? window : globalThis);
