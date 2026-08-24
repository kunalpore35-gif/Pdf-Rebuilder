import { cfg, jsonError, safeFilename, uid, now } from "../utils/config.js";
import { saveJob, loadJob } from "../jobs/state.js";
import { putStream, head, key } from "../storage/mega.js";

export async function createJob(request,env){
  const c=cfg(env);
  let body; try{body=await request.json();}catch{return jsonError("Invalid JSON.");}
  if(!Array.isArray(body.files)||body.files.length<1) return jsonError("At least one PDF is required.");
  if(body.files.length>c.maxFiles) return jsonError(`Maximum ${c.maxFiles} files per batch.`);
  const jobId=uid("blink"); const files=[];
  for(let i=0;i<body.files.length;i++){
    const f=body.files[i]||{};
    if(String(f.type||"application/pdf")!=="application/pdf") return jsonError(`File ${i+1} is not a PDF.`);
    const size=Number(f.size||0);
    if(!Number.isFinite(size)||size<=0||size>c.maxFileBytes) return jsonError(`File ${f.name||i+1} exceeds the ${c.maxFileBytes/1024/1024} MB upload limit.`);
    const fileId=`f${String(i+1).padStart(2,"0")}_${crypto.randomUUID().slice(0,8)}`;
    files.push({fileId,name:safeFilename(f.name),size,type:"application/pdf",key:key.input(jobId,fileId),status:"pending",pageCount:null,processedPages:0,processedChunks:[]});
  }
  const job={jobId,status:"queued",totalFiles:files.length,totalPages:0,processedPages:0,progress:0,currentFile:"",currentPage:0,error:null,retryCount:0,createdAt:now(),startedAt:null,completedAt:null,outputPath:null,outputPages:0,formatMode:body.formatMode==="handwritten"?"handwritten":"normal",documentMode:["auto","notes","pyq"].includes(body.documentMode)?body.documentMode:"auto",model:String(body.model||c.defaultModel).trim().slice(0,100),instructions:String(body.instructions||"").slice(0,12000),files};
  await saveJob(env,job);
  return Response.json({jobId,files:files.map(({fileId,name,size,type,key})=>({fileId,name,size,type,key})),limits:{maxFiles:c.maxFiles,maxPages:c.maxPages,maxFileSizeMB:c.maxFileBytes/1024/1024}});
}

export async function uploadFile(request,env){
  const url=new URL(request.url); const jobId=url.searchParams.get("jobId"); const fileId=url.searchParams.get("fileId");
  const job=await loadJob(env,jobId); if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  const f=job.files.find(x=>x.fileId===fileId); if(!f)return jsonError("File not found.",404,"NOT_FOUND");
  const len=Number(request.headers.get("content-length")||0);
  if(len && len!==Number(f.size)) return jsonError("Upload size does not match job metadata.",409,"UPLOAD_SIZE_MISMATCH");
  if(len>cfg(env).maxFileBytes)return jsonError("File too large.");
  const ct=(request.headers.get("content-type")||"").split(";")[0].toLowerCase();
  if(ct && ct!=="application/pdf" && ct!=="application/octet-stream") return jsonError("PDF content type required.");
  if(!request.body)return jsonError("Upload body missing.");
  await putStream(env,f.key,request.body,f.size,"application/pdf");
  return Response.json({ok:true,fileId,key:f.key});
}
