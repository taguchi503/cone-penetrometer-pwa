'use strict';

const APP_VERSION = '1.0.4';
const STORAGE_KEY = 'cone_pwa_draft_v1';
const SAVED_KEY = 'cone_pwa_saved_v1';
const UPDATE_BACKUP_KEY = 'cone_pwa_update_backup_v1';
const MAX_DIAL = 232.1;
const DEPTHS = Array.from({length: 11}, (_, i) => +(i / 10).toFixed(1));
const DEFAULT_SETTINGS = { K: 4.4, m1: 0.78, m0: 0.135, area: 0.000645 };

const $ = (id) => document.getElementById(id);
const fields = ['projectName','pointNo','groundLevel','operatorName','testDate','weather'];
let state = makeBlankState();
let toastTimer;
let swRegistration = null;
let updateInProgress = false;
let remoteVersion = null;

function makeBlankState(){
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    projectName:'', pointNo:'', groundLevel:'', operatorName:'',
    testDate: new Date().toISOString().slice(0,10), weather:'',
    settings: {...DEFAULT_SETTINGS},
    measurements: DEPTHS.map(depth => ({depth, rods:1, dial:'', note:''})),
    updatedAt: new Date().toISOString(), version: APP_VERSION
  };
}

function qrdN(dial, s){ return s.K * dial; }
function qcValue(dial, rods, s){
  if (!Number.isFinite(dial) || !Number.isFinite(rods)) return null;
  const qrd = qrdN(dial, s);
  const selfWeightN = (s.m0 + rods * s.m1) * 9.81;
  return (qrd + selfWeightN) / (1000 * s.area);
}

function renderRows(){
  const root = $('measureRows');
  root.innerHTML = '';
  state.measurements.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className='measure-row';
    row.dataset.index=idx;

    const depth = document.createElement('div');
    depth.className='depth';
    depth.textContent=m.depth.toFixed(1);

    const rods = document.createElement('input');
    rods.type='number'; rods.inputMode='numeric'; rods.min='0'; rods.step='1';
    rods.value=m.rods;
    rods.setAttribute('aria-label',`深さ${m.depth}m ロッド本数`);

    const dial = document.createElement('input');
    dial.type='number'; dial.inputMode='decimal'; dial.min='0'; dial.max=MAX_DIAL; dial.step='0.1';
    dial.value=m.dial; dial.placeholder='0.0';
    dial.setAttribute('aria-label',`深さ${m.depth}m ダイヤル読み`);

    const qc = document.createElement('div');
    qc.className='qc';
    qc.textContent=formatQc(calcRow(m).qc);

    const note = document.createElement('input');
    note.type='text';
    note.className='measure-note';
    note.value=m.note||'';
    note.placeholder='記事（例：転石に当たり貫入不可）';
    note.setAttribute('aria-label',`深さ${m.depth}m 記事`);

    rods.addEventListener('input',()=>{m.rods=toNumberOrBlank(rods.value); updateAll();});
    dial.addEventListener('input',()=>{m.dial=dial.value; updateAll();});
    note.addEventListener('input',()=>{m.note=note.value; updateAll();});

    row.append(depth,rods,dial,qc,note);
    root.appendChild(row);
  });
  updateAll(false);
}

function calcRow(m){
  const dial = Number(m.dial);
  const rods = Number(m.rods);
  if (m.dial === '' || !Number.isFinite(dial) || !Number.isFinite(rods)) return {qrd:null,qc:null,invalid:false};
  return {qrd:qrdN(dial,state.settings), qc:qcValue(dial,rods,state.settings), invalid:dial<0 || dial>MAX_DIAL};
}

function combinedNote(m,c=calcRow(m)){
  const parts=[];
  if(c.invalid) parts.push('校正範囲外');
  if(String(m.note||'').trim()) parts.push(String(m.note).trim());
  return parts.join(' / ');
}

function updateAll(autosave=true){
  readTopFields(); readSettings();
  let warningCount=0, latest=null;
  document.querySelectorAll('.measure-row').forEach((row,idx)=>{
    const c=calcRow(state.measurements[idx]);
    row.querySelector('.qc').textContent=formatQc(c.qc);
    row.classList.toggle('invalid',c.invalid);
    if(c.invalid) warningCount++;
    if(c.qc!==null) latest=c.qc;
  });
  $('rangeWarning').classList.toggle('hidden',warningCount===0);
  $('rangeWarning').textContent=warningCount?`校正範囲（0〜${MAX_DIAL}）外の読み値が ${warningCount} 件あります。該当値は参考値として扱い、測定器の状態を確認してください。`:'';
  $('latestQc').textContent=latest===null?'qc --':`qc ${latest.toFixed(1)}`;
  drawChart($('profileChart'), state.measurements);
  syncPrintView();
  if(autosave){
    state.updatedAt=new Date().toISOString();
    state.version=APP_VERSION;
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  }
}

function readTopFields(){ fields.forEach(k=> state[k]=$(k).value); }
function readSettings(){
  state.settings={
    K:num($('settingK').value,DEFAULT_SETTINGS.K),
    m1:num($('settingM1').value,DEFAULT_SETTINGS.m1),
    m0:num($('settingM0').value,DEFAULT_SETTINGS.m0),
    area:num($('settingArea').value,DEFAULT_SETTINGS.area)
  };
}
function applyState(){
  fields.forEach(k=>$(k).value=state[k]??'');
  $('settingK').value=state.settings.K;
  $('settingM1').value=state.settings.m1;
  $('settingM0').value=state.settings.m0;
  $('settingArea').value=state.settings.area;
  renderRows();
}

function drawChart(svg, measurements){
  const W=680,H=520, L=78,R=24,T=48,B=52, plotW=W-L-R, plotH=H-T-B, xmax=2000,ymax=1.0;
  const pts=[];
  measurements.forEach(m=>{const c=calcRow(m); if(c.qc!==null && Number.isFinite(c.qc)) pts.push({x:c.qc,y:Number(m.depth),invalid:c.invalid});});
  let out=`<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>`;
  for(let x=0;x<=xmax;x+=100){
    const px=L+x/xmax*plotW; const major=x%500===0;
    out+=`<line x1="${px}" y1="${T}" x2="${px}" y2="${T+plotH}" stroke="${major?'#9db2c5':'#e3ebf2'}" stroke-width="${major?1.2:.7}"/>`;
    if(major) out+=`<text x="${px}" y="${T-13}" text-anchor="middle" font-size="15" fill="#354b60">${x}</text>`;
  }
  for(let y=0;y<=10;y++){
    const val=y/10, py=T+val/ymax*plotH;
    out+=`<line x1="${L}" y1="${py}" x2="${L+plotW}" y2="${py}" stroke="${y%5===0?'#9db2c5':'#e3ebf2'}" stroke-width="${y%5===0?1.2:.7}"/>`;
    out+=`<text x="${L-13}" y="${py+5}" text-anchor="end" font-size="14" fill="#354b60">${val.toFixed(1)}</text>`;
  }
  out+=`<rect x="${L}" y="${T}" width="${plotW}" height="${plotH}" fill="none" stroke="#5f7488" stroke-width="1.2"/><text x="${L+plotW/2}" y="22" text-anchor="middle" font-size="15" font-weight="700" fill="#18324a">qc [kN/m²]</text><text transform="translate(20 ${T+plotH/2}) rotate(-90)" text-anchor="middle" font-size="15" font-weight="700" fill="#18324a">深さ [m]</text>`;
  if(pts.length){
    const path=pts.map((p,i)=>`${i?'L':'M'} ${L+Math.min(p.x,xmax)/xmax*plotW} ${T+p.y/ymax*plotH}`).join(' ');
    out+=`<path d="${path}" fill="none" stroke="#0b5cab" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(p=>{
      const px=L+Math.min(p.x,xmax)/xmax*plotW,py=T+p.y/ymax*plotH;
      out+=`<circle cx="${px}" cy="${py}" r="5" fill="${p.invalid?'#b42318':'#0a7f82'}" stroke="white" stroke-width="2"/>`;
    });
  }
  if(!pts.length) out+=`<text x="${L+plotW/2}" y="${T+plotH/2}" text-anchor="middle" font-size="18" fill="#8a9aaa">ダイヤル読み値を入力するとグラフを表示します</text>`;
  svg.innerHTML=out;
}

function drawPrintChart(svg, measurements){
  const W=560,H=930,L=62,R=8,T=42,B=12, plotW=W-L-R, plotH=H-T-B, xmax=2000, ymax=1.0;
  const pts=[];
  measurements.forEach(m=>{const c=calcRow(m); if(c.qc!==null && Number.isFinite(c.qc)) pts.push({x:c.qc,y:Number(m.depth),invalid:c.invalid});});
  let out=`<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>`;
  out+=`<text x="18" y="18" text-anchor="middle" font-size="13" fill="#000">深　さ</text><text x="18" y="34" text-anchor="middle" font-size="11" fill="#000">m</text>`;
  out+=`<text x="${L+plotW/2}" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="#000">qc　kN/m²</text>`;
  for(let x=0;x<=xmax;x+=100){const px=L+x/xmax*plotW; const major=x%500===0; out+=`<line x1="${px}" y1="${T}" x2="${px}" y2="${T+plotH}" stroke="#f4a900" stroke-width="${major?1.2:.75}"/>`; if(major) out+=`<text x="${px}" y="${T-8}" text-anchor="middle" font-size="10" fill="#000">${x.toFixed(2)}</text>`;}
  for(let i=0;i<=20;i++){const y=i/20,py=T+y/ymax*plotH; const major=i%2===0; out+=`<line x1="${L}" y1="${py}" x2="${L+plotW}" y2="${py}" stroke="#f4a900" stroke-width="${major?1.2:.75}"/>`; if(major) out+=`<text x="${L-10}" y="${py+4}" text-anchor="end" font-size="11" fill="#000">${y.toFixed(1)}</text>`;}
  out+=`<line x1="${L}" y1="${T}" x2="${L}" y2="${T+plotH}" stroke="#000" stroke-width="2.2"/>`;
  if(pts.length){
    const path=pts.map((p,i)=>`${i?'L':'M'} ${L+Math.max(0,Math.min(p.x,xmax))/xmax*plotW} ${T+Math.max(0,Math.min(p.y,ymax))/ymax*plotH}`).join(' ');
    out+=`<path d="${path}" fill="none" stroke="#000" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(p=>{const px=L+Math.max(0,Math.min(p.x,xmax))/xmax*plotW,py=T+Math.max(0,Math.min(p.y,ymax))/ymax*plotH;out+=`<circle cx="${px}" cy="${py}" r="5.2" fill="#000"/>`;});
  }
  svg.innerHTML=out;
}

function syncPrintView(){
  const values={
    projectName:state.projectName, pointNo:state.pointNo, groundLevel:state.groundLevel,
    operatorName:state.operatorName, testDate:state.testDate, testDateJP:formatDateJP(state.testDate),
    weather:state.weather, K:state.settings.K, m1:state.settings.m1, m0:state.settings.m0, area:state.settings.area
  };
  document.querySelectorAll('[data-print]').forEach(el=>el.textContent=values[el.dataset.print]??'');
  const tbody=$('printTable').querySelector('tbody');
  tbody.innerHTML='';
  state.measurements.forEach(m=>{
    const c=calcRow(m);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${m.depth.toFixed(1)}</td><td>${m.rods}</td><td>${m.dial===''?'':escapeHtml(m.dial)}</td><td>${c.qrd===null?'':c.qrd.toFixed(1)}</td><td>${c.qc===null?'':c.qc.toFixed(1)}</td><td>${escapeHtml(combinedNote(m,c))}</td>`;
    tbody.appendChild(tr);
  });
  for(let i=0;i<32;i++){
    const tr=document.createElement('tr');
    tr.className='blank';
    tr.innerHTML='<td></td><td></td><td></td><td></td><td></td><td></td>';
    tbody.appendChild(tr);
  }
  drawPrintChart($('printProfileChart'),state.measurements);
}

function persistRecord(rec){
  const saved=getSaved();
  rec.id=rec.id||Date.now().toString();
  rec.updatedAt=new Date().toISOString();
  rec.version=APP_VERSION;
  const i=saved.findIndex(x=>x.id===rec.id);
  if(i>=0)saved[i]=rec; else saved.unshift(rec);
  localStorage.setItem(SAVED_KEY,JSON.stringify(saved.slice(0,100)));
  return rec;
}

function saveCurrent(){
  updateAll(false);
  const rec=persistRecord(structuredCloneSafe(state));
  localStorage.setItem(STORAGE_KEY,JSON.stringify(rec));
  state=rec;
  showToast('端末に保存しました');
}

function saveAndNext(){
  updateAll(false);
  const rec=persistRecord(structuredCloneSafe(state));
  const next=makeBlankState();
  next.projectName=rec.projectName;
  next.pointNo='';
  next.groundLevel=rec.groundLevel;
  next.operatorName=rec.operatorName;
  next.testDate=rec.testDate;
  next.weather=rec.weather;
  next.settings={...rec.settings};
  state=next;
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  applyState();
  $('pointNo').focus();
  showToast('保存しました。次の地点番号を入力してください');
}

function getUpdateBackup(){
  try{return JSON.parse(localStorage.getItem(UPDATE_BACKUP_KEY)||'null');}catch{return null;}
}
function getSaved(){
  try{return JSON.parse(localStorage.getItem(SAVED_KEY)||'[]');}
  catch{
    const backup=getUpdateBackup();
    try{return backup?.saved?JSON.parse(backup.saved):[];}catch{return[];}
  }
}
function showHistory(){
  const list=$('historyList'); list.innerHTML='';
  const saved=getSaved();
  if(!saved.length) list.innerHTML='<div class="hint">保存データはありません。</div>';
  saved.forEach(rec=>{
    const el=document.createElement('div'); el.className='history-item';
    const main=document.createElement('div'); main.className='history-main';
    main.innerHTML=`<div class="history-title">${escapeHtml(rec.projectName||'名称未入力')} / ${escapeHtml(rec.pointNo||'地点未入力')}</div><div class="history-sub">${escapeHtml(rec.testDate||'')}　更新 ${new Date(rec.updatedAt).toLocaleString('ja-JP')}</div>`;
    const acts=document.createElement('div'); acts.className='history-actions';
    const load=document.createElement('button'); load.type='button'; load.className='btn btn-light'; load.textContent='開く';
    load.onclick=()=>{state=normalizeState(rec);applyState();localStorage.setItem(STORAGE_KEY,JSON.stringify(state));$('historyDialog').close();showToast('読み込みました');};
    const del=document.createElement('button'); del.type='button'; del.className='btn btn-light'; del.textContent='削除';
    del.onclick=()=>{if(confirm('この保存データを削除しますか？')){localStorage.setItem(SAVED_KEY,JSON.stringify(getSaved().filter(x=>x.id!==rec.id)));showHistory();}};
    acts.append(load,del); el.append(main,acts); list.appendChild(el);
  });
  $('historyDialog').showModal();
}

function exportJson(){
  updateAll(false);
  download(`${safeName(state.projectName||'cone')}_${safeName(state.pointNo||'data')}.json`,JSON.stringify(state,null,2),'application/json');
}
function importJson(file){
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const obj=JSON.parse(reader.result);
      state=normalizeState(obj);
      applyState();
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
      showToast('データを読み込みました');
    }catch(e){
      alert('読み込みに失敗しました。PWAから出力したJSONファイルを選んでください。');
    }
  };
  reader.readAsText(file);
}
function normalizeState(obj){
  const base=makeBlankState();
  return {
    ...base,
    ...obj,
    settings:{...DEFAULT_SETTINGS,...(obj.settings||{})},
    measurements:DEPTHS.map((d,i)=>({...base.measurements[i],...(obj.measurements?.[i]||{}),depth:d,note:obj.measurements?.[i]?.note||''})),
    version:APP_VERSION
  };
}

function buildExcelPayload(){
  updateAll(false);
  return {
    projectName:state.projectName,
    pointNo:state.pointNo,
    groundLevel:state.groundLevel,
    operatorName:state.operatorName,
    testDateJP:formatDateJP(state.testDate),
    weather:state.weather,
    settings:{...state.settings},
    measurements:state.measurements.map(m=>{
      const c=calcRow(m);
      return {...m,qrd:c.qrd,qc:c.qc,invalid:c.invalid};
    })
  };
}
async function exportExcel(){
  try{
    const payload=buildExcelPayload();
    const name=`${safeName(state.projectName||'ポータブルコーン貫入試験')}_${safeName(state.pointNo||'測定')}.xlsx`;
    await ConeExcel.exportFilled(payload,name);
    showToast('Excel帳票を出力しました');
  }catch(e){
    console.error(e);
    alert('Excel帳票の出力に失敗しました。通信状態またはアプリの更新状態を確認してください。');
  }
}
async function exportBlankExcel(){
  try{
    await ConeExcel.downloadBlank('ポータブルコーン貫入試験_空白様式.xlsx');
    showToast('空白Excel様式を出力しました');
  }catch(e){
    console.error(e);
    alert('空白Excel様式の出力に失敗しました。');
  }
}

function startNew(){
  if(!confirm('現在の入力をクリアして新規測定を開始しますか？'))return;
  state=makeBlankState(); applyState();
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  showToast('新規測定を開始しました');
}
function resetSettings(){
  state.settings={...DEFAULT_SETTINGS};
  $('settingK').value=state.settings.K; $('settingM1').value=state.settings.m1; $('settingM0').value=state.settings.m0; $('settingArea').value=state.settings.area;
  updateAll(); showToast('標準設定へ戻しました');
}
function setSettingsLock(){
  const unlocked=$('unlockSettings').checked;
  ['settingK','settingM1','settingM0','settingArea'].forEach(id=>$(id).readOnly=!unlocked);
}
function updateOnline(){
  const b=$('onlineBadge');
  b.textContent=navigator.onLine?'オンライン':'オフライン';
  b.classList.toggle('offline',!navigator.onLine);
}
function showToast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),1900);
}
function download(name,text,type){
  const blob=new Blob([text],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function formatDateJP(v){
  if(!v)return '';
  const m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?`${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`:String(v);
}
function num(v,fallback){const n=Number(v);return Number.isFinite(n)?n:fallback;}
function toNumberOrBlank(v){return v===''?'':Number(v);}
function formatQc(v){return v===null?'--':v.toFixed(1);}
function safeName(v){return String(v).replace(/[\\/:*?"<>|]/g,'_').trim()||'data';}
function escapeHtml(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function structuredCloneSafe(v){return typeof structuredClone==='function'?structuredClone(v):JSON.parse(JSON.stringify(v));}

function compareVersions(a,b){
  const A=String(a).split('.').map(n=>parseInt(n,10)||0), B=String(b).split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<Math.max(A.length,B.length);i++){
    const d=(A[i]||0)-(B[i]||0);
    if(d) return d;
  }
  return 0;
}
function saveUpdateBackup(){
  try{
    updateAll(false);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    localStorage.setItem(UPDATE_BACKUP_KEY,JSON.stringify({
      createdAt:new Date().toISOString(),
      fromVersion:APP_VERSION,
      draft:localStorage.getItem(STORAGE_KEY)||'',
      saved:localStorage.getItem(SAVED_KEY)||'[]'
    }));
  }catch(e){console.warn('更新前バックアップに失敗',e);}
}
function showUpdateBanner(version){
  remoteVersion=version;
  $('updateTitle').textContent=`最新版 v${version} があります`;
  $('updateText').textContent='端末内の入力途中データ・保存データを保持したまま更新できます。';
  $('updateBanner').classList.remove('hidden');
}
function hideUpdateBanner(){ $('updateBanner').classList.add('hidden'); }
async function checkForUpdate(){
  if(!navigator.onLine) return;
  try{
    const r=await fetch(`./version.json?ts=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) return;
    const info=await r.json();
    const version=String(info.version||'').trim();
    if(version && compareVersions(version,APP_VERSION)>0) showUpdateBanner(version);
  }catch(e){console.debug('更新確認をスキップ',e);}
}
async function registerCurrentServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  try{
    swRegistration=await navigator.serviceWorker.register(`./service-worker.js?v=${encodeURIComponent(APP_VERSION)}`,{scope:'./'});
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(updateInProgress) location.reload();
    });
  }catch(e){console.warn('Service Worker登録失敗',e);}
}
async function performSafeUpdate(){
  if(!remoteVersion || updateInProgress) return;
  updateInProgress=true;
  const btn=$('updateNowBtn');
  btn.disabled=true; btn.textContent='更新中…';
  saveUpdateBackup();
  let reloaded=false;
  const reload=()=>{if(reloaded)return;reloaded=true;location.reload();};
  try{
    const reg=await navigator.serviceWorker.register(`./service-worker.js?v=${encodeURIComponent(remoteVersion)}`,{scope:'./'});
    swRegistration=reg;
    const tryActivate=()=>{
      if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
      if(reg.installing){
        reg.installing.addEventListener('statechange',()=>{
          if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
        });
      }
    };
    tryActivate();
    await reg.update().catch(()=>{});
    tryActivate();
    setTimeout(reload,2200);
  }catch(e){
    console.error(e);
    updateInProgress=false;
    btn.disabled=false; btn.textContent='最新版へ更新';
    alert('更新に失敗しました。通信状態を確認してもう一度お試しください。保存データは削除されていません。');
  }
}

function bind(){
  fields.forEach(k=>$(k).addEventListener('input',updateAll));
  ['settingK','settingM1','settingM0','settingArea'].forEach(k=>$(k).addEventListener('input',updateAll));
  $('unlockSettings').addEventListener('change',setSettingsLock);
  $('resetSettingsBtn').addEventListener('click',resetSettings);
  $('newBtn').addEventListener('click',startNew);
  $('saveBtn').addEventListener('click',saveCurrent);
  $('saveNextBtn').addEventListener('click',saveAndNext);
  $('historyBtn').addEventListener('click',showHistory);
  $('exportBtn').addEventListener('click',exportJson);
  $('excelBtn').addEventListener('click',exportExcel);
  $('blankExcelBtn').addEventListener('click',exportBlankExcel);
  $('printBtn').addEventListener('click',()=>{updateAll(false);window.print();});
  $('importFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importJson(f);e.target.value='';});
  $('updateNowBtn').addEventListener('click',performSafeUpdate);
  $('updateLaterBtn').addEventListener('click',hideUpdateBanner);
  addEventListener('online',()=>{updateOnline();checkForUpdate();});
  addEventListener('offline',updateOnline);
}

function loadInitialState(){
  const draft=localStorage.getItem(STORAGE_KEY);
  if(draft){
    try{return normalizeState(JSON.parse(draft));}
    catch{
      const backup=getUpdateBackup();
      try{if(backup?.draft) return normalizeState(JSON.parse(backup.draft));}catch{}
    }
  }
  return makeBlankState();
}

async function init(){
  bind(); updateOnline(); setSettingsLock();
  state=loadInitialState();
  applyState();
  await registerCurrentServiceWorker();
  checkForUpdate();
}
init();
