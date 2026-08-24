import { safeFilename } from "../utils/config.js";

const sleep = ms => new Promise(r=>setTimeout(r,ms));

export async function uploadToGemini(env, object, displayName){
  if(!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const size=Number(object.size||0);
  const startUrl=`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const start=await fetch(startUrl,{
    method:"POST",
    headers:{
      "X-Goog-Upload-Protocol":"resumable",
      "X-Goog-Upload-Command":"start",
      "X-Goog-Upload-Header-Content-Length":String(size),
      "X-Goog-Upload-Header-Content-Type":"application/pdf",
      "Content-Type":"application/json"
    },
    body:JSON.stringify({file:{display_name:safeFilename(displayName)}})
  });
  if(!start.ok) throw new Error(`Gemini file-upload start failed (${start.status}).`);
  const uploadUrl=start.headers.get("X-Goog-Upload-URL") || start.headers.get("x-goog-upload-url");
  if(!uploadUrl) throw new Error("Gemini did not return a resumable upload URL.");

  const source=await object.body;
  const sent=await fetch(uploadUrl,{
    method:"POST",
    headers:{
      "Content-Length":String(size),
      "X-Goog-Upload-Offset":"0",
      "X-Goog-Upload-Command":"upload, finalize"
    },
    body:source
  });
  if(!sent.ok) throw new Error(`Gemini file upload failed (${sent.status}).`);
  const info=await sent.json();
  const file=info.file;
  if(!file?.uri) throw new Error("Gemini file upload returned no file URI.");

  // Wait for ACTIVE state.
  for(let i=0;i<30;i++){
    const meta=await getGeminiFile(env,file.name);
    if(meta.state==="ACTIVE") return meta;
    if(meta.state==="FAILED") throw new Error("Gemini rejected the uploaded PDF.");
    await sleep(Math.min(5000,500+i*150));
  }
  throw new Error("Gemini file processing timed out.");
}

export async function getGeminiFile(env,name){
  const r=await fetch(`${env.GEMINI_API_BASE||"https://generativelanguage.googleapis.com/v1beta"}/${name}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`);
  if(!r.ok) throw new Error(`Gemini file metadata failed (${r.status}).`);
  return r.json();
}

export async function deleteGeminiFile(env,name){
  if(!name)return;
  try{await fetch(`${env.GEMINI_API_BASE||"https://generativelanguage.googleapis.com/v1beta"}/${name}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{method:"DELETE"});}catch{}
}

export function blinkPrompt({instructions,formatMode,documentMode,startPage,endPage,totalPages}){
  const style = formatMode==="handwritten" ? "HANDWRITTEN" : "NORMAL";
  const mode = documentMode==="pyq" ? "PYQ / QUESTION BANK" : documentMode==="notes" ? "NOTES / STUDY MATERIAL" : "AUTO";
  return `You are the server-side BLINK Study Notes Rebuilder.

SOURCE OF TRUTH: the attached PDF. Do not invent facts that are absent from the source.

BLINK MODE: ${mode}
OUTPUT STYLE: ${style}

PROCESS ONLY SOURCE PAGES ${startPage}-${endPage} of ${totalPages}. Preserve reading order. Do not omit questions, options, formulas, tables, diagrams, examples or explanatory text from those pages.
If a section begins before ${startPage} or ends after ${endPage}, include only the content visible in this page range and mark the section with sourcePages.

For PYQ, preserve question numbers, options, years/sessions, answers/solutions and organize questions by actual chapter/topic without inventing missing information.
For NOTES, rewrite as clear study notes while preserving source concepts, formulas, examples and diagrams.

For EVERY section add CHAPTER immediately after TITLE. Use the actual chapter name from the source; if genuinely unclear, use General.

OUTPUT FORMAT:
===SECTION===
ID: sec-1
TITLE: 1. Topic Name
CHAPTER: Chapter Name
SOURCEPAGES: 1-2
---HTML---
<p>raw html...</p>
===ENDSECTION===

Allowed HTML:
<p>, <b>, <i>, <sup>, <sub>, <ul>, <ol>, <li>,
<h2 class="sec">, <h3 class="subsec">,
<div class="formula">,
<div class="diagram-box"> or <div class="diagram-box wide"> containing a self-contained SVG,
<div class="diagram-caption">,
<div class="trick"><b class="label">Trick:</b>...</div>,
<div class="mistake"><b class="label">Common mistake:</b>...</div>,
<div class="example"><b class="label">Example:</b>...</div>,
<table class="plain">...</table> or <table class="revtable">...</table>.

MATH: write formulas in LaTeX using $$...$$ for display and $...$ for inline. Never drop equations.
SVG: simple self-contained textbook line diagrams only. Use a viewBox of at least 320x240, stroke-width >=2 and readable labels.
Do not include script, style, iframe, object, external URLs or external images.
Never output markdown fences.
Never write the marker strings inside HTML.
Finish every section.

Additional user instructions:
${instructions || "(none)"}
`;
}

export async function generateFromGemini(env,{fileUri,model,prompt}){
  const url=`${env.GEMINI_API_BASE||"https://generativelanguage.googleapis.com/v1beta"}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  let last;
  for(let attempt=1;attempt<=4;attempt++){
    try{
      const r=await fetch(url,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          contents:[{role:"user",parts:[
            {file_data:{mime_type:"application/pdf",file_uri:fileUri}},
            {text:prompt}
          ]}],
          generationConfig:{temperature:0.6,maxOutputTokens:65536}
        })
      });
      if(r.status===429 || r.status>=500){
        last=new Error(`Gemini temporary error ${r.status}`);
        if(attempt<4){await sleep(1500*attempt*attempt);continue;}
      }
      if(!r.ok) throw new Error(`Gemini API error ${r.status}: ${(await r.text()).slice(0,400)}`);
      const data=await r.json();
      const parts=data?.candidates?.[0]?.content?.parts||[];
      const text=parts.map(p=>p.text||"").join("");
      if(!text) throw new Error("Gemini returned an empty response.");
      return text;
    }catch(e){
      last=e;
      if(attempt<4) await sleep(1000*attempt*attempt);
    }
  }
  throw last || new Error("Gemini generation failed.");
}

export function parseSections(raw){
  const out=[];
  const re=/===SECTION===\s*\r?\nID:\s*(.*?)\s*\r?\nTITLE:\s*(.*?)\s*\r?\n(?:CHAPTER:\s*(.*?)\s*\r?\n)?(?:SOURCEPAGES:\s*(.*?)\s*\r?\n)?---\s*HTML\s*-{0,3}\s*\r?\n([\s\S]*?)\r?\n?===ENDSECTION===/g;
  let m;
  while((m=re.exec(raw))){
    out.push({id:m[1].trim()||`sec-${out.length+1}`,title:m[2].trim()||"Untitled",chapter:(m[3]||"").trim(),sourcePages:(m[4]||"").trim(),html:m[5].trim()});
  }
  if(!out.length){
    const partial=/===SECTION===\s*\r?\nID:\s*(.*?)\s*\r?\nTITLE:\s*(.*?)\s*\r?\n(?:CHAPTER:\s*(.*?)\s*\r?\n)?(?:SOURCEPAGES:\s*(.*?)\s*\r?\n)?---\s*HTML\s*-{0,3}\s*\r?\n([\s\S]*)/m.exec(raw);
    if(partial && partial[6]?.trim()){
      out.push({id:partial[1].trim()||"sec-partial",title:`${partial[2].trim()||"Untitled"} ⚠ truncated`,chapter:(partial[3]||"").trim(),sourcePages:(partial[4]||"").trim(),html:partial[6].trim(),truncated:true});
    }
  }
  if(!out.length) throw new Error("Could not parse any BLINK sections from Gemini.");
  return out;
}

export async function detectPageCount(env,fileUri,model){
  const text=await generateFromGemini(env,{fileUri,model,prompt:`Return ONLY this exact JSON object for the attached PDF: {"pages":NUMBER}. NUMBER must be the actual PDF page count. Do not estimate.`});
  const m=text.match(/\{\s*"pages"\s*:\s*(\d+)\s*\}/);
  if(!m) throw new Error("Gemini did not return a valid page count.");
  return Number(m[1]);
}
