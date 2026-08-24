import { parseDocument } from "htmlparser2";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const A4={w:595.28,h:841.89};
const COLORS={navy:rgb(20/255,33/255,61/255),teal:rgb(43/255,111/255,143/255),gold:rgb(184/255,134/255,11/255),red:rgb(163/255,51/255,51/255),green:rgb(45/255,106/255,45/255),text:rgb(.10,.10,.10),grey:rgb(.35,.35,.35)};
const M={left:42,right:42,top:70,bottom:52};
const contentW=A4.w-M.left-M.right;
const contentBottom=M.bottom;
const contentTop=A4.h-M.top;

function attr(n,k){return n?.attribs?.[k]??""}
function cls(n){return attr(n,"class")}
function children(n){return n?.children||[]}
function textOf(n){return children(n).map(c=>c.type==="text"?c.data:textOf(c)).join("")}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function colorHex(hex){const m=String(hex||"").match(/^#([0-9a-f]{6})$/i);if(!m)return COLORS.navy;const x=parseInt(m[1],16);return rgb((x>>16&255)/255,(x>>8&255)/255,(x&255)/255)}

function latexReadable(s){
  let x=String(s).replace(/\\left|\\right/g,"").replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,"($1)/($2)")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g,"√($1)").replace(/\\times/g,"×").replace(/\\cdot/g,"·").replace(/\\pm/g,"±")
    .replace(/\\leq/g,"≤").replace(/\\geq/g,"≥").replace(/\\neq/g,"≠").replace(/\\to/g,"→")
    .replace(/\\pi/g,"π").replace(/\\theta/g,"θ").replace(/\\lambda/g,"λ").replace(/\\mu/g,"μ")
    .replace(/\\alpha/g,"α").replace(/\\beta/g,"β").replace(/\\gamma/g,"γ").replace(/\\Delta/g,"Δ")
    .replace(/\\sum/g,"Σ").replace(/\\infty/g,"∞").replace(/\\approx/g,"≈")
    .replace(/\\mathbf\{([^{}]*)\}/g,"$1").replace(/\\mathrm\{([^{}]*)\}/g,"$1")
    .replace(/\\text\{([^{}]*)\}/g,"$1").replace(/[{}]/g,"");
  x=x.replace(/\\([A-Za-z]+)/g,"$1");
  return x;
}

function inlineRuns(node, style={}){
  const out=[];
  function walk(n,s){
    if(n.type==="text"){
      const raw=n.data||"";
      const parts=raw.split(/(\$\$[\s\S]*?\$\$|\$[^$]+\$)/g).filter(Boolean);
      for(const p of parts){
        if(p.startsWith("$$")||p.startsWith("$")) out.push({text:latexReadable(p.replace(/^\$+|\$+$/g,"")),style:{...s,math:true}});
        else if(p) out.push({text:p,style:{...s}});
      }
      return;
    }
    if(n.type!=="tag")return;
    const ns={...s};
    if(n.name==="b"||n.name==="strong")ns.bold=true;
    if(n.name==="i"||n.name==="em")ns.italic=true;
    if(n.name==="sup")ns.sup=true;
    if(n.name==="sub")ns.sub=true;
    for(const c of children(n))walk(c,ns);
  }
  walk(node,style);
  return out;
}

function makeBlocks(html,section){
  const root=parseDocument(html||"");
  const blocks=[];
  const walk=(n)=>{
    for(const c of children(n)){
      if(c.type!=="tag")continue;
      const name=c.name.toLowerCase(), cclass=cls(c);
      if(["p","h2","h3"].includes(name)){
        blocks.push({type:name==="p"?"paragraph":name==="h2"?"section":"subsection",runs:inlineRuns(c),section,atomic:false});
      }else if(name==="div" && cclass.includes("formula")){
        blocks.push({type:"formula",runs:inlineRuns(c),section,atomic:true});
      }else if(name==="div" && cclass.includes("diagram-box")){
        const svg=children(c).find(x=>x.type==="tag"&&x.name==="svg");
        const cap=children(c).find(x=>x.type==="tag"&&x.name==="div"&&cls(x).includes("diagram-caption"));
        blocks.push({type:"diagram",svg:svg?serializeSvg(svg):"",caption:cap?textOf(cap):"",wide:cclass.includes("wide"),section,atomic:true});
      }else if(name==="div" && (cclass.includes("trick")||cclass.includes("mistake")||cclass.includes("example"))){
        blocks.push({type:cclass.includes("trick")?"trick":cclass.includes("mistake")?"mistake":"example",runs:inlineRuns(c),section,atomic:true});
      }else if(name==="ul"||name==="ol"){
        const items=children(c).filter(x=>x.type==="tag"&&x.name==="li").map(x=>({runs:inlineRuns(x),ordered:name==="ol"}));
        blocks.push({type:"list",items,section,atomic:false});
      }else if(name==="table"){
        blocks.push({type:"table",rows:tableRows(c),section,atomic:true});
      }else{
        walk(c);
      }
    }
  };
  walk(root);
  return blocks;
}

function tableRows(table){
  return children(table).filter(x=>x.type==="tag"&&(x.name==="tr"||x.name==="thead"||x.name==="tbody")).flatMap(group=>{
    if(group.name==="tr") return [row(group)];
    return children(group).filter(x=>x.type==="tag"&&x.name==="tr").map(row);
  });
}
function row(tr){return children(tr).filter(x=>x.type==="tag"&&(x.name==="td"||x.name==="th")).map(c=>({runs:inlineRuns(c),header:c.name==="th"}));}
function serializeSvg(n){
  if(!n)return "";
  const attrs=Object.entries(n.attribs||{}).map(([k,v])=>`${k}="${esc(v)}"`).join(" ");
  return `<${n.name}${attrs?` ${attrs}`:""}>${children(n).map(c=>c.type==="text"?esc(c.data):serializeSvg(c)).join("")}</${n.name}>`;
}

function wrapRuns(runs,font,size,maxW){
  const lines=[];let line=[];let width=0;
  const push=()=>{if(line.length){lines.push({runs:line,width});line=[];width=0;}};
  for(const run of runs){
    const words=String(run.text).split(/(\s+)/);
    for(const word of words){
      if(!word)continue;
      const fs=run.style.math?size*.95:(run.style.sup||run.style.sub?size*.68:size);
      const f=run.style.bold?font.bold:(run.style.italic?font.italic:font.regular);
      const w=f.widthOfTextAtSize(word,fs);
      if(word.trim() && width+w>maxW && line.length) push();
      line.push({...run,text:word}); width+=w;
    }
  }
  push(); return lines;
}

function blockMetrics(block,font,hand){
  const base=hand?17:11;
  if(block.type==="paragraph") {
    const lines=wrapRuns(block.runs,font,hand?16:11.3,contentW);
    return {height:Math.max(1,lines.length)*(hand?23:16)+base,lines};
  }
  if(block.type==="section") return {height:32,lines:wrapRuns(block.runs,font,16.2,contentW)};
  if(block.type==="subsection") return {height:27,lines:wrapRuns(block.runs,font,14.2,contentW)};
  if(block.type==="formula") return {height:58,lines:wrapRuns(block.runs,font,14.5,contentW-20)};
  if(block.type==="list"){
    let h=4;const lines=[];for(const it of block.items){const ls=wrapRuns(it.runs,font,hand?15.5:10.8,contentW-20);lines.push(ls);h+=ls.length*(hand?22:15)+5;}return {height:h,lines};
  }
  if(["trick","mistake","example"].includes(block.type)){const ls=wrapRuns(block.runs,font,hand?15:10.7,contentW-22);return {height:Math.max(44,ls.length*(hand?22:15)+20),lines:ls};}
  if(block.type==="diagram"){
    const vb=(block.svg.match(/viewBox\s*=\s*["']([^"']+)["']/i)||[])[1]?.split(/\s+/).map(Number)||[0,0,600,320];
    const aspect=(vb[3]||320)/(vb[2]||600);
    const w=Math.min(contentW,block.wide?contentW:contentW*.78), h=Math.min(230,w*aspect);
    return {height:h+(block.caption?20:0)+20,width:w,heightDiagram:h};
  }
  if(block.type==="table"){
    const cols=Math.max(...block.rows.map(r=>r.length),1);let h=18;
    for(const r of block.rows){let rowH=18;for(const cell of r){const ls=wrapRuns(cell.runs,font,9.2,contentW/cols-12);rowH=Math.max(rowH,ls.length*12+8);}h+=rowH;}return {height:Math.min(h,contentTop-contentBottom-20),cols};
  }
  return {height:24};
}

function drawRuns(page,runs,x,y,maxW,font,size,hand=false){
  const lines=wrapRuns(runs,font,size,maxW);let yy=y;
  for(const line of lines){
    let xx=x;
    for(const run of line.runs){
      const fs=run.style.math?size*.95:(run.style.sup||run.style.sub?size*.68:size);
      const f=run.style.bold?font.bold:(run.style.italic?font.italic:font.regular);
      const dy=run.style.sup?size*.35:(run.style.sub?-size*.25:0);
      page.drawText(run.text,{x:xx,y:yy+dy,size:fs,font:f,color:COLORS.text});
      xx+=f.widthOfTextAtSize(run.text,fs);
    }
    yy-=hand?23:16;
  }
  return {lines,used:lines.length*(hand?23:16)};
}

function drawSvg(page,svg,x,y,w,h){
  const vb=(svg.match(/viewBox\s*=\s*["']([^"']+)["']/i)||[])[1]?.split(/\s+/).map(Number)||[0,0,600,320];
  const sx=w/(vb[2]||600), sy=h/(vb[3]||320), scale=Math.min(sx,sy);
  const ox=x+(w-(vb[2]||600)*scale)/2, oy=y+(h-(vb[3]||320)*scale)/2;
  const root=svg.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/i)?.[1]||svg;
  const tags=[...root.matchAll(/<(line|rect|circle|ellipse|polyline|polygon|path|text)\b([^>]*)>([\s\S]*?)<\/\1>|<(line|rect|circle|ellipse|polyline|polygon|path)\b([^>]*)\/?>/gi)];
  for(const m of tags){
    const type=m[1]||m[4], a=m[2]||m[5]||"", body=m[3]||"";
    const get=(k,d="")=>(a.match(new RegExp(`${k}\\s*=\\s*["']([^"']+)["']`,"i"))||[])[1]??d;
    const stroke=colorHex(get("stroke","#14213d")), fill=get("fill","none");
    const sw=Number(get("stroke-width","2"))*scale;
    const px=v=>ox+Number(v||0)*scale, py=v=>oy+(vb[3]-Number(v||0))*scale;
    if(type==="line") page.drawLine({start:{x:px(get("x1")),y:py(get("y1"))},end:{x:px(get("x2")),y:py(get("y2"))},thickness:sw,color:stroke});
    else if(type==="rect") page.drawRectangle({x:px(get("x")),y:py(Number(get("y"))+Number(get("height"))),width:Number(get("width"))*scale,height:Number(get("height"))*scale,borderColor:stroke,borderWidth:sw,color:fill==="none"?undefined:colorHex(fill)});
    else if(type==="circle") page.drawCircle({x:px(get("cx")),y:py(get("cy")),size:Number(get("r"))*scale,borderColor:stroke,borderWidth:sw,color:fill==="none"?undefined:colorHex(fill)});
    else if(type==="ellipse") page.drawEllipse({x:px(get("cx")),y:py(get("cy")),xScale:Number(get("rx"))*scale,yScale:Number(get("ry"))*scale,borderColor:stroke,borderWidth:sw,color:fill==="none"?undefined:colorHex(fill)});
    else if(type==="path"){const d=get("d");try{page.drawSvgPath(d,{x:ox,y:oy,scale,rotate:undefined,color:fill==="none"?undefined:colorHex(fill),borderColor:stroke,borderWidth:sw});}catch{}}
    else if(type==="text"){const t=body.replace(/<[^>]+>/g,"");page.drawText(t,{x:px(get("x")),y:py(get("y")),size:Number(get("font-size","16"))*scale,font:fontFallback(),color:stroke});}
  }
}
let _fallback;
function fontFallback(){return _fallback;}
function setFallback(f){_fallback=f;}

async function loadFonts(doc){
  doc.registerFontkit(fontkit);
  const normal=await doc.embedFont(StandardFonts.Helvetica);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const italic=await doc.embedFont(StandardFonts.HelveticaOblique);
  const hand=await doc.embedFont(StandardFonts.CourierOblique);
  return {regular:normal,bold,italic,hand};
}

function headerFooter(page,font,pageNo,total,hand){
  page.drawText("BLINK",{x:M.left,y:A4.h-28,size:20,font:font.bold,color:COLORS.navy});
  page.drawLine({start:{x:M.left+75,y:A4.h-24},end:{x:A4.w-M.right,y:A4.h-24},thickness:1,color:COLORS.navy});
  page.drawText("https://blink-studynotes.pages.dev",{x:A4.w/2-92,y:18,size:8.5,font:font.regular,color:COLORS.navy});
  page.drawLine({start:{x:M.left,y:34},end:{x:A4.w-M.right,y:34},thickness:1,color:COLORS.navy});
  page.drawText(String(pageNo),{x:A4.w-M.right-18,y:18,size:8,font:font.bold,color:COLORS.grey});
}

function drawBlock(page,block,metric,x,y,font,hand){
  const size=hand?15.5:11.3;
  if(block.type==="paragraph"||block.type==="section"||block.type==="subsection"){
    const fs=block.type==="section"?16.2:block.type==="subsection"?14.2:size;
    const f=block.type==="section"||block.type==="subsection"?font.bold:font;
    const yy=y-(block.type==="section"?8:0);
    if(block.type==="section"){page.drawLine({start:{x,y:yy-4},end:{x:x+contentW,y:yy-4},thickness:1.2,color:COLORS.navy});}
    drawRuns(page,block.runs,x,yy,contentW,f,fs,hand);
    return;
  }
  if(block.type==="formula"){
    page.drawRectangle({x:x-6,y:y-metric.height+10,width:contentW+12,height:metric.height-16,borderColor:COLORS.teal,borderWidth:.7,color:rgb(.98,.99,1)});
    drawRuns(page,block.runs,x+4,y-4,contentW-8,font,14.5,hand);
    return;
  }
  if(["trick","mistake","example"].includes(block.type)){
    const c=block.type==="trick"?COLORS.gold:block.type==="mistake"?COLORS.red:COLORS.green;
    page.drawRectangle({x:x-4,y:y-metric.height+8,width:contentW+8,height:metric.height-10,borderColor:c,borderWidth:1.2,color:rgb(1,1,1)});
    page.drawRectangle({x:x-4,y:y-metric.height+8,width:4,height:metric.height-10,color:c});
    drawRuns(page,block.runs,x+9,y-5,contentW-18,font,size,hand);
    return;
  }
  if(block.type==="list"){
    let yy=y-2;
    block.items.forEach((it,i)=>{
      const bullet=it.ordered?`${i+1}.`:"•";
      page.drawText(bullet,{x,y:yy,size:size,font:font.bold,color:COLORS.navy});
      const used=drawRuns(page,it.runs,x+16,yy,contentW-16,font,size,hand).used;
      yy-=used+4;
    });
    return;
  }
  if(block.type==="diagram"){
    const h=metric.heightDiagram||180;
    drawSvg(page,block.svg,x+(contentW-metric.width)/2,y-h,metric.width,h);
    if(block.caption) page.drawText(block.caption,{x,y:y-h-12,size:8.5,font:font.italic,color:COLORS.grey,maxWidth:contentW});
    return;
  }
  if(block.type==="table"){
    const cols=metric.cols||1; const cw=contentW/cols; let yy=y-2;
    for(const r of block.rows){
      let rh=18; const wrapped=r.map(cell=>wrapRuns(cell.runs,font,9.2,cw-10));for(const ls of wrapped)rh=Math.max(rh,ls.length*12+8);
      if(yy-rh<contentBottom) break;
      r.forEach((cell,i)=>{
        page.drawRectangle({x:x+i*cw,y:yy-rh,width:cw,height:rh,borderColor:rgb(.65,.65,.65),borderWidth:.5,color:cell.header?rgb(.95,.96,.98):undefined});
        drawRuns(page,cell.runs,x+i*cw+5,yy-11,cw-10,font,9.2,false);
      }); yy-=rh;
    }
  }
}

export async function buildBlinkPdf({sections,formatMode,sourceTitle}){
  const doc=await PDFDocument.create();
  const font=await loadFonts(doc); setFallback(font.regular);
  const hand=formatMode==="handwritten";
  const usedFont=hand?{regular:font.hand,bold:font.hand,italic:font.hand}:font;
  const blocks=sections.flatMap(s=>makeBlocks(s.html||"",s));
  // Add chapter/topic headings exactly once, then content.
  const withTitles=[];
  let lastChapter="";
  for(const s of sections){
    const ch=(s.chapter||"General").trim()||"General";
    if(ch!==lastChapter){withTitles.push({type:"section",runs:[{text:ch,style:{bold:true}}],section:s,atomic:false});lastChapter=ch;}
    withTitles.push({type:"subsection",runs:[{text:s.title||"Untitled",style:{bold:true}}],section:s,atomic:false});
    const sb=makeBlocks(s.html||"",s);
    withTitles.push(...sb);
  }

  let page=doc.addPage([A4.w,A4.h]),pageNo=1,y=contentTop;
  const pageSvgs=[]; let pageSvgParts=[];
  const flushPreview=()=>{pageSvgs.push(`<svg xmlns="http://www.w3.org/2000/svg" width="595.28" height="841.89" viewBox="0 0 595.28 841.89">${pageSvgParts.join("")}</svg>`);pageSvgParts=[];};
  headerFooter(page,usedFont,pageNo,0,hand);
  pageSvgParts.push(`<text x="${M.left}" y="28" font-family="Arial" font-size="20" font-weight="700" fill="#14213d">BLINK</text><line x1="${M.left+75}" y1="24" x2="${A4.w-M.right}" y2="24" stroke="#14213d"/>`);

  for(const block of withTitles){
    const metric=blockMetrics(block,usedFont,hand);
    const gap=block.type==="section"?10:6;
    if(metric.height>contentTop-contentBottom){
      // Oversized atomic blocks are scaled down at draw time by the caller's metric.
      metric.height=contentTop-contentBottom-2;
    }
    if(y-metric.height<contentBottom){
      page.drawText(String(pageNo),{x:A4.w-M.right-18,y:18,size:8,font:font.bold,color:COLORS.grey});
      flushPreview();
      page=doc.addPage([A4.w,A4.h]);pageNo++;y=contentTop;headerFooter(page,usedFont,pageNo,0,hand);
    }
    drawBlock(page,block,metric,M.left,y,usedFont,hand);
    // Preview uses conservative text rectangles rather than attempting browser layout.
    const py=A4.h-y;
    const fill=block.type==="section"?"#14213d":block.type==="subsection"?"#2b6f8f":"#202020";
    const label=block.type==="diagram"?"[diagram]":block.type==="table"?"[table]":block.type==="formula"?latexReadable(block.runs?.map(r=>r.text).join("")):block.runs?.map(r=>r.text).join("")||"";
    const safe=esc(label.slice(0,180));
    pageSvgParts.push(`<text x="${M.left}" y="${py}" font-family="${hand?"Comic Sans MS":"Georgia"}" font-size="${block.type==="section"?16:block.type==="subsection"?13:10.5}" fill="${fill}">${safe}</text>`);
    y-=metric.height+gap;
  }
  page.drawText(String(pageNo),{x:A4.w-M.right-18,y:18,size:8,font:font.bold,color:COLORS.grey});
  flushPreview();
  const bytes=await doc.save({useObjectStreams:true,addDefaultPage:false});
  return {bytes,pageCount:pageNo,previewSvgs:pageSvgs,sourceTitle};
}
