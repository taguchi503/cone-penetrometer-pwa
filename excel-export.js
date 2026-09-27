'use strict';

(() => {
  const TEMPLATE_URL = './templates/cone-template.xlsx';
  const textDecoder = new TextDecoder('utf-8');
  const textEncoder = new TextEncoder();

  function u16(view, off){ return view.getUint16(off, true); }
  function u32(view, off){ return view.getUint32(off, true); }

  function findEocd(view){
    const min = Math.max(0, view.byteLength - 65557);
    for(let i=view.byteLength-22; i>=min; i--){
      if(u32(view,i)===0x06054b50) return i;
    }
    throw new Error('ZIP終端が見つかりません');
  }

  function readStoredZip(arrayBuffer){
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const eocd = findEocd(view);
    const count = u16(view, eocd + 10);
    let pos = u32(view, eocd + 16);
    const entries = [];
    for(let i=0;i<count;i++){
      if(u32(view,pos)!==0x02014b50) throw new Error('ZIP中央ディレクトリが不正です');
      const method = u16(view,pos+10);
      const compSize = u32(view,pos+20);
      const nameLen = u16(view,pos+28);
      const extraLen = u16(view,pos+30);
      const commentLen = u16(view,pos+32);
      const localOff = u32(view,pos+42);
      const name = textDecoder.decode(bytes.slice(pos+46,pos+46+nameLen));
      if(method!==0) throw new Error('Excelテンプレートの圧縮形式が未対応です');
      if(u32(view,localOff)!==0x04034b50) throw new Error('ZIPローカルヘッダーが不正です');
      const localNameLen = u16(view,localOff+26);
      const localExtraLen = u16(view,localOff+28);
      const dataStart = localOff + 30 + localNameLen + localExtraLen;
      entries.push({name, data:bytes.slice(dataStart,dataStart+compSize)});
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  const crcTable = (()=>{
    const t=new Uint32Array(256);
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++) c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);
      t[n]=c>>>0;
    }
    return t;
  })();

  function crc32(bytes){
    let c=0xffffffff;
    for(const b of bytes) c=crcTable[(c^b)&0xff]^(c>>>8);
    return (c^0xffffffff)>>>0;
  }

  function dosDateTime(date=new Date()){
    const year=Math.max(1980,date.getFullYear());
    return {
      time:((date.getHours()&31)<<11)|((date.getMinutes()&63)<<5)|((Math.floor(date.getSeconds()/2))&31),
      date:(((year-1980)&127)<<9)|(((date.getMonth()+1)&15)<<5)|(date.getDate()&31)
    };
  }

  function writeStoredZip(entries){
    const now=dosDateTime();
    let localSize=0, centralSize=0;
    const meta=entries.map(e=>{
      const nameBytes=textEncoder.encode(e.name);
      const data=e.data instanceof Uint8Array?e.data:new Uint8Array(e.data);
      const crc=crc32(data);
      localSize += 30 + nameBytes.length + data.length;
      centralSize += 46 + nameBytes.length;
      return {name:e.name,nameBytes,data,crc};
    });
    const total=localSize+centralSize+22;
    const out=new Uint8Array(total);
    const view=new DataView(out.buffer);
    let p=0;
    const locals=[];
    for(const e of meta){
      const off=p; locals.push(off);
      view.setUint32(p,0x04034b50,true); p+=4;
      view.setUint16(p,20,true); p+=2;
      view.setUint16(p,0x0800,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint16(p,now.time,true); p+=2;
      view.setUint16(p,now.date,true); p+=2;
      view.setUint32(p,e.crc,true); p+=4;
      view.setUint32(p,e.data.length,true); p+=4;
      view.setUint32(p,e.data.length,true); p+=4;
      view.setUint16(p,e.nameBytes.length,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      out.set(e.nameBytes,p); p+=e.nameBytes.length;
      out.set(e.data,p); p+=e.data.length;
    }
    const centralStart=p;
    meta.forEach((e,i)=>{
      view.setUint32(p,0x02014b50,true); p+=4;
      view.setUint16(p,20,true); p+=2;
      view.setUint16(p,20,true); p+=2;
      view.setUint16(p,0x0800,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint16(p,now.time,true); p+=2;
      view.setUint16(p,now.date,true); p+=2;
      view.setUint32(p,e.crc,true); p+=4;
      view.setUint32(p,e.data.length,true); p+=4;
      view.setUint32(p,e.data.length,true); p+=4;
      view.setUint16(p,e.nameBytes.length,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint16(p,0,true); p+=2;
      view.setUint32(p,0,true); p+=4;
      view.setUint32(p,locals[i],true); p+=4;
      out.set(e.nameBytes,p); p+=e.nameBytes.length;
    });
    const centralLen=p-centralStart;
    view.setUint32(p,0x06054b50,true); p+=4;
    view.setUint16(p,0,true); p+=2;
    view.setUint16(p,0,true); p+=2;
    view.setUint16(p,meta.length,true); p+=2;
    view.setUint16(p,meta.length,true); p+=2;
    view.setUint32(p,centralLen,true); p+=4;
    view.setUint32(p,centralStart,true); p+=4;
    view.setUint16(p,0,true); p+=2;
    return out;
  }

  function xmlEscape(v){
    return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  }
  function reEscape(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

  function replaceCell(xml, ref, mode, value){
    const re=new RegExp(`<c([^>]*\\br="${reEscape(ref)}"[^>]*)>([\\s\\S]*?)<\\/c>`);
    if(!re.test(xml)) throw new Error(`Excelテンプレートのセル ${ref} が見つかりません`);
    return xml.replace(re,(all,attrs,inner)=>{
      attrs=attrs.replace(/\s+t="[^"]*"/g,'');
      if(mode==='string'){
        return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }
      if(mode==='number'){
        return `<c${attrs} t="n"><v>${Number(value)}</v></c>`;
      }
      if(mode==='blank') return `<c${attrs}></c>`;
      if(mode==='formulaCache'){
        const fm=inner.match(/<f[^>]*>[\s\S]*?<\/f>/);
        return `<c${attrs}>${fm?fm[0]:''}<v>${value==null?'':Number(value)}</v></c>`;
      }
      return all;
    });
  }

  function replaceCalcSettings(xml){
    if(/<calcPr\b[^>]*\/>/.test(xml)){
      return xml.replace(/<calcPr\b[^>]*\/>/,'<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
    }
    return xml.replace('</workbook>','<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  }

  function numCache(values,formatCode){
    const pts=[];
    values.forEach((v,idx)=>{if(v!==null && v!=='' && Number.isFinite(Number(v))) pts.push(`<pt idx="${idx}"><v>${Number(v)}</v></pt>`);});
    return `<numCache><formatCode xml:space="preserve">${xmlEscape(formatCode)}</formatCode><ptCount val="${values.length}"/>${pts.join('')}</numCache>`;
  }

  function replaceFirstSeriesCache(chartXml,qcValues,depthValues){
    const serRe=/<ser>[\s\S]*?<\/ser>/;
    const m=chartXml.match(serRe);
    if(!m) return chartXml;
    let ser=m[0];
    ser=ser.replace(/(<xVal><numRef><f>[\s\S]*?<\/f>)<numCache>[\s\S]*?<\/numCache>(<\/numRef><\/xVal>)/,
      `$1${numCache(qcValues,'0.00_ ')}$2`);
    ser=ser.replace(/(<yVal><numRef><f>[\s\S]*?<\/f>)<numCache>[\s\S]*?<\/numCache>(<\/numRef><\/yVal>)/,
      `$1${numCache(depthValues,'0.0_ ')}$2`);
    return chartXml.replace(serRe,ser);
  }

  function combinedNote(m){
    const parts=[];
    if(m.invalid) parts.push('校正範囲外');
    if(String(m.note||'').trim()) parts.push(String(m.note).trim());
    return parts.join(' / ');
  }

  function modifyWorkbookEntries(entries,payload){
    const map=new Map(entries.map(e=>[e.name,{...e,data:new Uint8Array(e.data)}]));
    const sheetEntry=map.get('xl/worksheets/sheet1.xml');
    if(!sheetEntry) throw new Error('Excelテンプレートのシートが見つかりません');
    let sheet=textDecoder.decode(sheetEntry.data);
    const s=payload.settings||{};
    const textCells={
      E2:payload.projectName||'', C3:payload.groundLevel||'', G3:payload.pointNo||'',
      Q2:payload.testDateJP||'', Q3:payload.operatorName||'', Q6:payload.weather||''
    };
    for(const [ref,v] of Object.entries(textCells)) sheet=replaceCell(sheet,ref,v?'string':'blank',v);
    sheet=replaceCell(sheet,'R4','number',s.K??4.4);
    sheet=replaceCell(sheet,'F5','number',s.m1??0.78);
    sheet=replaceCell(sheet,'L5','number',s.m0??0.135);
    sheet=replaceCell(sheet,'R5','number',s.area??0.000645);
    const qcValues=[], depthValues=[];
    (payload.measurements||[]).slice(0,11).forEach((m,i)=>{
      const r=10+i;
      depthValues.push(Number(m.depth));
      sheet=replaceCell(sheet,`B${r}`,'number',m.rods===''?0:m.rods);
      if(m.dial==='' || m.dial==null){
        sheet=replaceCell(sheet,`E${r}`,'blank','');
        sheet=replaceCell(sheet,`G${r}`,'formulaCache',null);
        sheet=replaceCell(sheet,`H${r}`,'formulaCache',null);
        qcValues.push(null);
      }else{
        sheet=replaceCell(sheet,`E${r}`,'number',m.dial);
        sheet=replaceCell(sheet,`G${r}`,'formulaCache',m.qrd);
        sheet=replaceCell(sheet,`H${r}`,'formulaCache',m.qc);
        qcValues.push(Number.isFinite(Number(m.qc))?Number(m.qc):null);
      }
      const note=combinedNote(m);
      sheet=replaceCell(sheet,`J${r}`,note?'string':'blank',note);
    });
    sheetEntry.data=textEncoder.encode(sheet);

    const wbEntry=map.get('xl/workbook.xml');
    if(wbEntry) wbEntry.data=textEncoder.encode(replaceCalcSettings(textDecoder.decode(wbEntry.data)));
    const chartEntry=map.get('xl/charts/chart1.xml');
    if(chartEntry) chartEntry.data=textEncoder.encode(replaceFirstSeriesCache(textDecoder.decode(chartEntry.data),qcValues,depthValues));
    return entries.map(e=>map.get(e.name)||e);
  }

  let templatePromise=null;
  async function getTemplateBytes(){
    if(!templatePromise){
      templatePromise=fetch(TEMPLATE_URL,{cache:'no-store'}).then(r=>{
        if(!r.ok) throw new Error('Excelテンプレートを取得できません');
        return r.arrayBuffer();
      });
    }
    return templatePromise;
  }

  async function buildWorkbookBytes(templateArrayBuffer,payload){
    const entries=readStoredZip(templateArrayBuffer);
    const modified=modifyWorkbookEntries(entries,payload);
    return writeStoredZip(modified);
  }

  function saveBlob(blob,filename){
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1200);
  }

  async function exportFilled(payload,filename){
    const template=await getTemplateBytes();
    const bytes=await buildWorkbookBytes(template,payload);
    saveBlob(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),filename);
  }

  async function downloadBlank(filename){
    const template=await getTemplateBytes();
    saveBlob(new Blob([template],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),filename);
  }

  globalThis.ConeExcel={exportFilled,downloadBlank,buildWorkbookBytes,readStoredZip,writeStoredZip};
})();
