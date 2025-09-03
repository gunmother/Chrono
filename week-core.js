/* week-core.js — UI-agnostic weekly scheduling engine
   - No styles, no DOM layout.
   - You provide render callbacks to paint into your new UI.
*/

export class WeekCore {
  constructor(opts = {}) {
    // ---- Render hooks (all optional) ----
    this.onRenderTitle   = opts.onRenderTitle   || (()=>{});
    this.onRenderLabels  = opts.onRenderLabels  || (()=>{});
    this.onRenderHours   = opts.onRenderHours   || (()=>{});
    this.onRenderBlocks  = opts.onRenderBlocks  || (()=>{}); // (slots, geom, colors)
    this.onRenderMask    = opts.onRenderMask    || (()=>{});
    this.onRenderNowHint = opts.onRenderNowHint || (()=>{}); // (rect or null)

    // ---- Geometry probe (required for painting) ----
    // Must return {width, height} for the weekly grid drawing area.
    if (typeof opts.measureGrid !== 'function') {
      throw new Error('WeekCore: opts.measureGrid() required');
    }
    this.measureGrid = opts.measureGrid;

    // ---- Config / model ----
    this.SLOTS_PER_DAY = 96; // 15-minute slots
    this.DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    this.SHORT_DOW  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Default task catalog (you can replace or extend)
    this.TASKS = opts.tasks || [
      {key:'work',     label:'Work',        color:'#D33C36', hard:true},
      {key:'commute',  label:'Commute',     color:'#E86A13', hard:true},
      {key:'chores',   label:'Chores',      color:'#3B41C5', hard:true},
      {key:'errands',  label:'Errands',     color:'#1D8F2E', hard:true},
      {key:'meals',    label:'Meal Time',   color:'#E0B21B'},
      {key:'hygiene',  label:'Hygiene',     color:'#0EA5E9'},
      {key:'selfcare', label:'Self care',   color:'#A3A3A3'},
      {key:'exercise', label:'Exercise',    color:'#1DB954'},
      {key:'family',   label:'Family Time', color:'#E3326B'},
      {key:'hobbies',  label:'Hobbies',     color:'#F39C12'},
      {key:'leisure',  label:'Leisure',     color:'#6B5B95'},
      {key:'school',   label:'School',      color:'#3269E6', hard:true},
      {key:'relax',    label:'Relaxation',  color:'#24C3D6'},
      {key:'free',     label:'Free Time',   color:'#77C043'},
      {key:'routines', label:'Routines',    color:'#7A5C2E'},
      {key:'sleep',    label:'Sleep',       color:'#6AA6FF'}
    ];

    this.COLORS = Object.fromEntries(this.TASKS.map(t=>[t.key,t.color]));
    this.LABELS = Object.fromEntries(this.TASKS.map(t=>[t.key,t.label]));

    // Persistent stores (you may hydrate/serialize outside)
    this.EXACT = Object.fromEntries(this.TASKS.map(t=>[t.key, this._blankWeekRanges()])); // recurring template
    this.EXCEPTIONS = { byDate:{}, byWeek:{}, byMonth:{} }; // overrides
    this.LAST_SCOPE = {}; // per-task last used scope
    this.ORDER = { recurring:{}, week:{}, month:{} }; // first-writer-wins (lower seq wins)
    this._saveSeq = 1;

    // View state
    this.weekOffset = 0;      // 0 = current week
    this.visibleWeekFirst = null;

    // Render cache
    this._geom = null;
    this._allSlots = this._blankWeekSlots();

    // Build initial
    this.gotoWeek(0);
  }

  /* ---------- Public API you’ll call from your new UI ---------- */

  setColor(taskKey, hex){ this.COLORS[taskKey]=hex; }
  setLabel(taskKey, name){ this.LABELS[taskKey]=name; }

  /** Replace the default TASKS/labels/colors entirely (optional) */
  replaceCatalog(tasks){
    this.TASKS = tasks.slice();
    this.COLORS = Object.fromEntries(this.TASKS.map(t=>[t.key,t.color]));
    this.LABELS = Object.fromEntries(this.TASKS.map(t=>[t.key,t.label]));
    // Keep existing data; you can migrate externally if keys changed
  }

  /** Navigate weeks: -1 prev, +1 next, 0 current */
  gotoWeek(delta = 0){
    this.weekOffset += delta;
    const today = new Date();
    const first = new Date(today);
    first.setDate(today.getDate() - today.getDay() + this.weekOffset*7);
    first.setHours(0,0,0,0);
    this.visibleWeekFirst = first;
    this._render();
  }

  /** Force a full rebuild/paint (e.g., after container resize) */
  rebuild(){ this._render(true); }

  /** Computed durations (minutes) for visible week per taskKey */
  getDurations(){
    const out={};
    for(const t of this.TASKS){
      out[t.key] = this._countMinutesForVisibleWeek(t.key);
    }
    return out;
  }

  /** Current visible week title string */
  getWeekTitle(){
    const first = this.visibleWeekFirst;
    const last = this._addDays(first,6);
    const m = new Intl.DateTimeFormat(undefined,{month:'short'});
    if(first.getFullYear()===last.getFullYear()){
      if(first.getMonth()===last.getMonth()){
        return `${m.format(first)} ${first.getDate()} – ${last.getDate()}, ${first.getFullYear()}`;
      }
      return `${m.format(first)} ${first.getDate()} – ${m.format(last)} ${last.getDate()}, ${first.getFullYear()}`;
    }
    return `${m.format(first)} ${first.getDate()}, ${first.getFullYear()} – ${m.format(last)} ${last.getDate()}, ${last.getFullYear()}`;
  }

  /** Active scope heuristic for a task in the visible week */
  activeScopeForTask(taskKey){
    const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
    const moKey = this._fmtMonthKey(this.visibleWeekFirst);
    const todayKey = this._fmtDate(this._startOfDay(new Date()));
    if(this.EXCEPTIONS.byDate[todayKey]?.[taskKey]) return 'today';
    if(this.EXCEPTIONS.byWeek[wkKey]?.[taskKey])     return 'week';
    if(this.EXCEPTIONS.byMonth[moKey]?.[taskKey])    return 'month';
    return 'recurring';
  }

  /** Load exact ranges for an editor given a scope */
  getExactForScope(taskKey, scope){
    if(scope==='recurring') return this._deepCopyWeek(this.EXACT[taskKey]);

    if(scope==='week'){
      const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
      const set = this.EXCEPTIONS.byWeek[wkKey]?.[taskKey];
      return this._deepCopyWeek(set || this.EXACT[taskKey]);
    }

    if(scope==='month'){
      const moKey = this._fmtMonthKey(this.visibleWeekFirst);
      const set = this.EXCEPTIONS.byMonth[moKey]?.[taskKey];
      return this._deepCopyWeek(set || this.EXACT[taskKey]);
    }

    // today: single-day array positioned in the week slot
    const out = this._blankWeekRanges();
    const {index} = this._getTodayTargetInVisibleWeek();
    const dateKey = this._fmtDate(this._addDays(this.visibleWeekFirst, index));
    const set = this.EXCEPTIONS.byDate[dateKey]?.[taskKey];
    if(set){
      out[index] = set.map(r=>({startMin:r.startMin,endMin:r.endMin}));
    }else{
      const eff = this._effectiveExactForTask(taskKey);
      out[index] = eff[index].map(r=>({startMin:r.startMin,endMin:r.endMin}));
    }
    return out;
  }

  /** Save edited ranges for a task at a scope (applies non-overwrite rules and ordering). */
  saveRanges(taskKey, scope, weekRanges){
    this.LAST_SCOPE[taskKey] = scope;

    // Normalize + clip against occupancy (task can move its own)
    const {week, spillNextDay} = this._normalizeAndClip(scope, taskKey, weekRanges);

    if(scope==='recurring'){
      this.EXACT[taskKey] = week;
      if(!this.ORDER.recurring[taskKey]) this.ORDER.recurring[taskKey] = this._saveSeq++;
    } else if(scope==='week'){
      const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
      this.EXCEPTIONS.byWeek[wkKey] = this.EXCEPTIONS.byWeek[wkKey] || {};
      this.EXCEPTIONS.byWeek[wkKey][taskKey] = week;
      this.ORDER.week[wkKey] = this.ORDER.week[wkKey] || {};
      if(!this.ORDER.week[wkKey][taskKey]) this.ORDER.week[wkKey][taskKey] = this._saveSeq++;
    } else if(scope==='month'){
      const moKey = this._fmtMonthKey(this.visibleWeekFirst);
      this.EXCEPTIONS.byMonth[moKey] = this.EXCEPTIONS.byMonth[moKey] || {};
      this.EXCEPTIONS.byMonth[moKey][taskKey] = week;
      this.ORDER.month[moKey] = this.ORDER.month[moKey] || {};
      if(!this.ORDER.month[moKey][taskKey]) this.ORDER.month[moKey][taskKey] = this._saveSeq++;
    } else { // today
      const {date, index} = this._getTodayTargetInVisibleWeek();
      const dateKey = this._fmtDate(date);
      const nextKey = this._fmtDate(this._addDays(date,1));
      const todayRanges = week[index] || [];

      if(todayRanges.length){
        this.EXCEPTIONS.byDate[dateKey] = this.EXCEPTIONS.byDate[dateKey] || {};
        this.EXCEPTIONS.byDate[dateKey][taskKey] = todayRanges;
      }else if(this.EXCEPTIONS.byDate[dateKey]?.[taskKey]){
        delete this.EXCEPTIONS.byDate[dateKey][taskKey];
        if(Object.keys(this.EXCEPTIONS.byDate[dateKey]).length===0) delete this.EXCEPTIONS.byDate[dateKey];
      }

      if(spillNextDay.length){
        this.EXCEPTIONS.byDate[nextKey] = this.EXCEPTIONS.byDate[nextKey] || {};
        this.EXCEPTIONS.byDate[nextKey][taskKey] = spillNextDay;
      }else if(this.EXCEPTIONS.byDate[nextKey]?.[taskKey]){
        delete this.EXCEPTIONS.byDate[nextKey][taskKey];
        if(Object.keys(this.EXCEPTIONS.byDate[nextKey]).length===0) delete this.EXCEPTIONS.byDate[nextKey];
      }
    }

    this._render(); // reflect changes
  }

  /** Export/import stores (for persistence) */
  getState(){
    return {
      EXACT: this._deepCopyExactMap(this.EXACT),
      EXCEPTIONS: JSON.parse(JSON.stringify(this.EXCEPTIONS)),
      ORDER: JSON.parse(JSON.stringify(this.ORDER)),
      LAST_SCOPE: JSON.parse(JSON.stringify(this.LAST_SCOPE))
    };
  }
  setState({EXACT, EXCEPTIONS, ORDER, LAST_SCOPE}){
    if(EXACT) this.EXACT = this._ensureExactShape(EXACT);
    if(EXCEPTIONS) this.EXCEPTIONS = JSON.parse(JSON.stringify(EXCEPTIONS));
    if(ORDER) this.ORDER = JSON.parse(JSON.stringify(ORDER));
    if(LAST_SCOPE) this.LAST_SCOPE = JSON.parse(JSON.stringify(LAST_SCOPE));
    this._render(true);
  }

  /* ---------- Internal: compute + render ---------- */

  _render(forceGeom = false){
    // Title + labels
    this.onRenderTitle(this.getWeekTitle());
    this.onRenderLabels(this.SHORT_DOW);

    // Hours stamps (00:00..23:00) — you can ignore in callback if you style differently
    this.onRenderHours(Array.from({length:24},(_,h)=>`${String(h).padStart(2,'0')}:00`));

    // Geometry
    const size = this.measureGrid();
    if(!size || !size.width || !size.height) return; // container not ready
    if(forceGeom || !this._geom || this._geom.totalW!==size.width || this._geom.totalH!==size.height){
      this._geom = this._computeGeometry(size.width, size.height);
      this.onRenderMask(this._geom); // grid mask/lines if you want them
    }

    // Recompute occupancy for visible week and paint
    this._rebuildSlotsForVisibleWeek();
    this.onRenderBlocks(this._allSlots, this._geom, this.COLORS);

    // Magnifier for “today” if inside visible week
    const rect = this._nowRectOrNull(this._geom);
    this.onRenderNowHint(rect);
  }

  _computeGeometry(totalW, totalH){
    // Split width into 7 columns (distribute remainders)
    const colWBase=Math.floor(totalW/7), extraW=totalW-colWBase*7;
    const colW=[], colX=[0];
    for(let c=0;c<7;c++){ const w=colWBase+(c<extraW?1:0); colW.push(w); colX.push(colX[c]+w); }
    // Split height into 24 rows then 15-min slots per hour
    const rowHBase=Math.floor(totalH/24), extraH=totalH-rowHBase*24;
    const rowH=[], rowY=[0];
    for(let rI=0;rI<24;rI++){ const h=rowHBase+(rI<extraH?1:0); rowH.push(h); rowY.push(rowY[rI]+h); }
    const slotHeightsPerHour=[]; for(let hr=0; hr<24; hr++){
      const h=rowH[hr], base=Math.floor(h/4), extra=h-base*4;
      const parts=[base,base,base,base]; const start=hr%4; for(let k=0;k<extra;k++) parts[(start+k)%4]+=1;
      slotHeightsPerHour.push(parts);
    }
    const slotY=[0]; for(let hr=0; hr<24; hr++){ for(let q=0; q<4; q++) slotY.push(slotY[slotY.length-1]+slotHeightsPerHour[hr][q]); }
    return { totalW, totalH, colW, colX, rowH, rowY, slotY };
  }

  _rebuildSlotsForVisibleWeek(){
    this._allSlots = this._blankWeekSlots();

    const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
    const moKey = this._fmtMonthKey(this.visibleWeekFirst);
    const seqForTask = (taskKey)=>{
      const seqs=[this.ORDER.week[wkKey]?.[taskKey], this.ORDER.month[moKey]?.[taskKey], this.ORDER.recurring?.[taskKey]];
      return seqs.filter(x=>typeof x==='number').sort((a,b)=>a-b)[0] ?? 1e9;
    };
    const ordered = [...this.TASKS.map(t=>t.key)].sort((a,b)=>seqForTask(a)-seqForTask(b));

    for(const key of ordered){
      const eff = this._effectiveExactForTask(key);
      this._applyRangesToSlots(key, eff, this._allSlots);
    }
  }

  _effectiveExactForTask(taskKey){
    let eff = this._deepCopyWeek(this.EXACT[taskKey]);
    const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
    const moKey = this._fmtMonthKey(this.visibleWeekFirst);
    const weekOverride  = this.EXCEPTIONS.byWeek[wkKey]?.[taskKey];
    const monthOverride = this.EXCEPTIONS.byMonth[moKey]?.[taskKey];
    if(monthOverride) eff = this._deepCopyWeek(monthOverride);
    if(weekOverride)  eff = this._deepCopyWeek(weekOverride);
    for(let d=0; d<7; d++){
      const dateKey = this._fmtDate(this._addDays(this.visibleWeekFirst,d));
      const dayOverride = this.EXCEPTIONS.byDate[dateKey]?.[taskKey];
      if(dayOverride) eff[d] = dayOverride.map(r=>({startMin:r.startMin,endMin:r.endMin}));
    }
    return eff;
  }

  _applyRangesToSlots(cat, exact, targetSlots){
    for(let d=0; d<7; d++){
      (exact[d]||[]).forEach(R=>{
        let a=this._round15(R.startMin), b=this._round15(R.endMin);
        if(b===a) return;
        if(b>a){
          let sa=this._minsToSlot(a), sb=this._minsToSlot(b);
          for(let s=sa; s<sb; s++) if(targetSlots[d][s]===null) targetSlots[d][s]=cat;
        } else {
          let sa=this._minsToSlot(a), sb=this._minsToSlot(24*60);
          for(let s=sa; s<sb; s++) if(targetSlots[d][s]===null) targetSlots[d][s]=cat;
          const dn=(d+1)%7;
          let sa2=this._minsToSlot(0), sb2=this._minsToSlot(b);
          for(let s=sa2; s<sb2; s++) if(targetSlots[dn][s]===null) targetSlots[dn][s]=cat;
        }
      });
    }
  }

  _nowRectOrNull(geom){
    // Only if today is in visible week
    const today=this._startOfDay(new Date());
    const visStart=this._startOfDay(this.visibleWeekFirst);
    const visEnd=this._startOfDay(this._addDays(this.visibleWeekFirst,6));
    if(today < visStart || today > visEnd) return null;

    const { colW, colX, rowY, totalH } = geom;
    const now=new Date(); const dow=now.getDay();
    const minutes=now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;
    const hour=Math.floor(minutes/60);
    const hourTop=rowY[hour]; const hourH=rowY[hour+1]-rowY[hour];
    const extra = Math.min(10, Math.floor(hourH*0.25));
    const top = Math.max(0, Math.min(totalH - (hourH+extra), hourTop - Math.floor(extra/2)));
    const height = Math.min(totalH - top, hourH + extra);
    const left=colX[dow]; const width=(dow===6)?Math.max(0,colW[dow]-1):colW[dow];
    return {left, top, width, height};
  }

  /* ---------- Collect/normalize/clip used by saveRanges ---------- */

  _normalizeAndClip(scope, taskKey, weekRanges){
    // Ensure shape and split overnight, 15-min rounding
    const norm = this._blankWeekRanges();
    let hadOvernight=false;

    for(let d=0; d<7; d++){
      for(const r of (weekRanges[d]||[])){
        let s=r.startMin|0, e=r.endMin|0;
        if(e> s){
          s=this._round15(s); e=this._round15(e);
          if(e>s) norm[d].push({startMin:s,endMin:e});
        } else if(e< s){
          hadOvernight=true;
          let s1=this._round15(s), e1=this._round15(24*60); if(e1>s1) norm[d].push({startMin:s1,endMin:e1});
          let s2=this._round15(0), e2=this._round15(e);
          const dn=(d+1)%7; if(e2>s2) norm[dn].push({startMin:s2,endMin:e2});
        }
      }
    }

    // Occupancy map excluding current task (so it can move its own claims)
    const occ = this._buildOccupancyMap(taskKey);

    // Clip to free or self-claimed slots, merge, max 4/day
    const clipped = this._blankWeekRanges();
    for(let d=0; d<7; d++){
      const req = Array(this.SLOTS_PER_DAY).fill(false);
      for(const r of norm[d]){ const a=this._minsToSlot(r.startMin), b=this._minsToSlot(r.endMin); for(let s=a;s<b;s++) req[s]=true; }
      let s=0;
      while(s<this.SLOTS_PER_DAY){
        while(s<this.SLOTS_PER_DAY && (!req[s] || !(occ[d][s]===null || occ[d][s]===taskKey))) s++;
        if(s>=this.SLOTS_PER_DAY) break;
        let e=s+1;
        while(e<this.SLOTS_PER_DAY && req[e] && (occ[d][e]===null || occ[d][e]===taskKey)) e++;
        const startMin=s*15, endMin=e*15;
        if(endMin>startMin) clipped[d].push({startMin, endMin});
        s=e;
      }
      clipped[d].sort((A,B)=>A.startMin-B.startMin);
      const merged=[];
      for(const r of clipped[d]){
        if(!merged.length) merged.push(r);
        else{
          const last=merged[merged.length-1];
          if(r.startMin<=last.endMin) last.endMin=Math.max(last.endMin,r.endMin);
          else merged.push(r);
        }
      }
      if(merged.length>4) merged.length=4;
      clipped[d]=merged;
    }

    // Spill info for today-overnight
    let spillNextDay=[];
    if(scope==='today' && hadOvernight){
      const {index}=this._getTodayTargetInVisibleWeek();
      const dn=(index+1)%7;
      spillNextDay = clipped[dn] || [];
    }

    return {week:clipped, spillNextDay};
  }

  _buildOccupancyMap(excludeTaskKey){
    const occ = this._blankWeekSlots();
    const wkKey = this._fmtWeekKey(this.visibleWeekFirst);
    const moKey = this._fmtMonthKey(this.visibleWeekFirst);
    const seqForTask = (taskKey)=>{
      const seqs=[this.ORDER.week[wkKey]?.[taskKey], this.ORDER.month[moKey]?.[taskKey], this.ORDER.recurring?.[taskKey]];
      return seqs.filter(x=>typeof x==='number').sort((a,b)=>a-b)[0] ?? 1e9;
    };
    const ordered = [...this.TASKS.map(t=>t.key)].sort((a,b)=>seqForTask(a)-seqForTask(b));
    for(const key of ordered){
      if(key===excludeTaskKey) continue;
      const eff = this._effectiveExactForTask(key);
      this._applyRangesToSlots(key, eff, occ);
    }
    return occ;
  }

  /* ---------- Small helpers ---------- */

  _blankWeekRanges(){ return Array.from({length:7},()=>[]); }
  _blankWeekSlots(){  return Array.from({length:7},()=>Array(this.SLOTS_PER_DAY).fill(null)); }
  _deepCopyWeek(w){ return Array.from({length:7},(_,i)=> (w?.[i]||[]).map(r=>({startMin:r.startMin,endMin:r.endMin}))); }
  _deepCopyExactMap(m){ return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,this._deepCopyWeek(v)])); }
  _ensureExactShape(m){ const out={}; for(const k in m){ out[k]=this._deepCopyWeek(m[k]); } return out; }

  _startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
  _addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  _fmtDate(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
  _fmtMonthKey(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'); return `${y}-${m}`; }
  _fmtWeekKey(first){ return this._fmtDate(first); }
  _round15(min){ return Math.round(min/15)*15; }
  _minsToSlot(min){ return Math.max(0, Math.min(this.SLOTS_PER_DAY, Math.round(min/15))); }

  _mergeDay(day){ const segs=[]; let i=0; while(i<this.SLOTS_PER_DAY){ const c=day[i]; let j=i+1; while(j<this.SLOTS_PER_DAY && day[j]===c) j++; segs.push({cat:c,startSlot:i,len:j-i}); i=j;} return segs; }

  _countMinutesForVisibleWeek(key){
    let count=0;
    for(let d=0; d<7; d++){ for(let s=0; s<this.SLOTS_PER_DAY; s++){ if(this._allSlots[d][s]===key) count++; } }
    return count*15;
  }

  _getTodayTargetInVisibleWeek(){
    const today=this._startOfDay(new Date());
    const visStart=this._startOfDay(this.visibleWeekFirst);
    const isCurrentWeek = today>=visStart && today<=this._startOfDay(this._addDays(visStart,6));
    if(isCurrentWeek){ return {date:today, index:today.getDay()}; }
    return {date:new Date(visStart), index:0};
  }
}

/* ---------- Minimal example wiring (you can delete this block) ----------
   import {WeekCore} from './week-core.js';
   const core = new WeekCore({
     measureGrid: () => {
       const el = document.getElementById('weekGrid');
       const r = el.getBoundingClientRect();
       return {width: Math.round(r.width), height: Math.round(r.height)};
     },
     onRenderTitle: (txt)=>{ document.getElementById('weekTitle').textContent = txt; },
     onRenderLabels: (names)=>{ /* write your labels */ },
     onRenderHours: (stamps)=>{ /* write your hour stamps */ },
     onRenderBlocks: (slots, geom, colors)=>{
       // Clear and draw absolute-positioned blocks using your own visuals.
       // slots[day][slotIndex] === taskKey | null
       // geom: {colX[], colW[], slotY[]}
     },
     onRenderMask: (geom)=>{ /* optional grid lines */ },
     onRenderNowHint: (rect)=>{ /* draw or hide current-time magnifier */ }
   });
   // navigate:
   // core.gotoWeek(+1); core.gotoWeek(-1);
   // open editor data:
   // const exact = core.getExactForScope('work','recurring');
   // save:
   // core.saveRanges('work','week', exact);
--------------------------------------------------------------------------- */
