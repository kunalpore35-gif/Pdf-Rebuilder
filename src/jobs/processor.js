import { cfg, now } from "../utils/config.js";
import { key, putBytes, deleteIf, head, getBytes, getStream, nodeToWebStream } from "../storage/mega.js";
import { loadJob, saveJob, checkpoint, readCheckpoint, setProgress } from "./state.js";
import { uploadToGemini, detectPageCount, generateFromGemini, blinkPrompt, parseSections, deleteGeminiFile } from "../pdf/gemini.js";
import { buildBlinkPdf } from "../pdf/layout.js";
import { PDFDocument } from "pdf-lib";


async function prepareFile(env,job,f){
  if(f.geminiFileUri && f.pageCount) return;
  const meta=await head(env,f.key);
  if(!meta) throw new Error(`Uploaded PDF missing: ${f.name}`);
  if(Number(meta.size)!==Number(f.size)) throw new Error(`Upload size mismatch for ${f.name}.`);
  const probe=await getBytes(env,f.key);
  const sig=new TextDecoder().decode(probe.slice(0,5));
  if(sig!=="%PDF-") throw new Error(`${f.name} is not a valid PDF.`);
  f.status="uploading to Gemini";
  const source=await getStream(env,f.key);
  if(!source) throw new Error(`Unable to open ${f.name} from MEGA.`);
  const gem=await uploadToGemini(env,{body:nodeToWebStream(source),size:meta.size},f.name);
  f.geminiFileName=gem.name; f.geminiFileUri=gem.uri; f.geminiMimeType=gem.mimeType||"application/pdf";
  const pages=await detectPageCount(env,gem.uri,job.model);
  if(!Number.isInteger(pages)||pages<1) throw new Error(`Could not determine page count for ${f.name}.`);
  f.pageCount=pages; f.totalChunks=Math.ceil(pages/cfg(env).chunkSize);
  job.totalPages=(job.files||[]).reduce((n,x)=>n+(x.pageCount||0),0);
  if(job.totalPages>cfg(env).maxPages) throw new Error(`Batch contains ${job.totalPages} pages; configured maximum is ${cfg(env).maxPages}.`);
  await saveJob(env,job);
}

async function renderChunk(env,job,f,chunkIndex){
  const c=cfg(env), start=chunkIndex*c.chunkSize+1, end=Math.min(f.pageCount,start+c.chunkSize-1);
  job.currentFile=f.name; job.currentPage=start; setProgress(job); await saveJob(env,job);
  const prompt=blinkPrompt({instructions:job.instructions,formatMode:job.formatMode,documentMode:job.documentMode,startPage:start,endPage:end,totalPages:f.pageCount});
  const raw=await generateFromGemini(env,{fileUri:f.geminiFileUri,model:job.model,prompt});
  const sections=parseSections(raw).map(s=>({...s,sourceFile:f.fileId,sourcePages:s.sourcePages||`${start}-${end}`}));
  if(!job.documentTitle){
    const counts={}; for(const s of sections){const c=(s.chapter||"").trim(); if(c) counts[c]=(counts[c]||0)+1;}
    job.documentTitle=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0] || f.name.replace(/\.pdf$/i,"").replace(/[_-]+/g," ").trim();
  }
  if(!sections.length) throw new Error(`No content returned for ${f.name} pages ${start}-${end}.`);
  const rendered=await buildBlinkPdf({sections,formatMode:job.formatMode,sourceTitle:f.name});
  const pdfKey=`jobs/${job.jobId}/chunks/${f.fileId}/${String(chunkIndex).padStart(5,"0")}.pdf`;
  await putBytes(env,pdfKey,rendered.bytes,"application/pdf");
  await checkpoint(env,job,f.fileId,chunkIndex,{startPage:start,endPage:end,sections,pdfKey,pdfPages:rendered.pageCount});
  for(let i=0;i<rendered.previewSvgs.length;i++){
    const globalPreviewPage=(job.outputPages||0)+i+1;
    await putBytes(env,key.preview(job.jobId,globalPreviewPage),rendered.previewSvgs[i],"image/svg+xml; charset=utf-8");
  }
  f.processedChunks=[...(f.processedChunks||[]),chunkIndex].filter((x,i,a)=>a.indexOf(x)===i).sort((a,b)=>a-b);
  f.processedPages=Math.min(f.pageCount,f.processedChunks.length*c.chunkSize);
  job.processedPages=Math.min(job.totalPages,(job.processedPages||0)+(end-start+1));
  job.outputPages=(job.outputPages||0)+rendered.pageCount;
  job.status="processing"; setProgress(job); await saveJob(env,job);
}

async function allChunksDone(job){
  return job.files.every(f=>f.pageCount && (f.processedChunks||[]).length>=f.totalChunks);
}

async function mergeFinal(env,job){
  const final=await PDFDocument.create();
  let outputPages=0;
  for(const f of job.files){
    for(let ci=0;ci<f.totalChunks;ci++){
      const cp=await readCheckpoint(env,job,f.fileId,ci);
      if(!cp?.pdfKey) throw new Error(`Missing checkpoint for ${f.name}, chunk ${ci}.`);
      const bytes=await getBytes(env,cp.pdfKey);
      const part=await PDFDocument.load(bytes,{ignoreEncryption:false});
      const pages=await final.copyPages(part,part.getPageIndices());
      pages.forEach(p=>final.addPage(p));
      outputPages+=pages.length;
    }
  }
  const bytes=await final.save({useObjectStreams:true,addDefaultPage:false});
  const outputKey=key.output(job.jobId);
  await putBytes(env,outputKey,bytes,"application/pdf");
  job.outputPath=outputKey; job.outputPages=outputPages; job.downloadName=`${job.documentTitle||"BLINK Notes"}.pdf`; job.status="completed"; job.completedAt=now(); job.processedPages=job.totalPages; setProgress(job);
  await saveJob(env,job);
  // Temporary Gemini files are deleted after finalization.
  for(const f of job.files) await deleteGeminiFile(env,f.geminiFileName);
  // Keep final PDF + previews. Remove input and chunk/checkpoint objects.
  for(const f of job.files){
    await deleteIf(env,f.key);
    for(let ci=0;ci<f.totalChunks;ci++){
      await deleteIf(env,key.checkpoint(job.jobId,f.fileId,ci));
      await deleteIf(env,`jobs/${job.jobId}/chunks/${f.fileId}/${String(ci).padStart(5,"0")}.pdf`);
    }
  }
}

export async function processJob(env,jobId,queue){
  const job=await loadJob(env,jobId);
  if(!job) return;
  if(["completed","cancelled"].includes(job.status)) return;
  if(!job.startedAt) job.startedAt=now();
  job.status="processing"; job.error=null; setProgress(job); await saveJob(env,job);

  try{
    // Prepare one file at a time; this avoids loading all PDFs into memory.
    for(const f of job.files){
      if(job.status==="cancelled") return;
      await prepareFile(env,job,f);
      for(let ci=0;ci<f.totalChunks;ci++){
        if(!(f.processedChunks||[]).includes(ci)){
          const recovered=await readCheckpoint(env,job,f.fileId,ci);
          if(recovered?.pdfKey && recovered?.sections){
            f.processedChunks=[...(f.processedChunks||[]),ci].sort((a,b)=>a-b);
            f.processedPages=Math.min(f.pageCount,f.processedChunks.length*cfg(env).chunkSize);
            job.processedPages=Math.min(job.totalPages,(job.processedPages||0)+(recovered.endPage-recovered.startPage+1));
            job.outputPages=(job.outputPages||0)+(recovered.pdfPages||0);
            await saveJob(env,job);
          }else{
            await renderChunk(env,job,f,ci);
          }
          // One durable queue message per successful chunk.
          await queue.send({jobId});
          return;
        }
      }
    }
    if(allChunksDone(job)) await mergeFinal(env,job);
  }catch(e){
    job.retryCount=(job.retryCount||0)+1;
    job.status="failed"; job.error=e?.message||String(e); setProgress(job); await saveJob(env,job);
    throw e;
  }
}

export async function retryJob(env,jobId,queue){
  const job=await loadJob(env,jobId); if(!job)return null;
  if(job.status==="completed")return job;
  job.status="queued";job.error=null;await saveJob(env,job);await queue.send({jobId});return job;
}
