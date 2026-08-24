import { jsonError } from "./utils/config.js";
import { corsHeaders, authorize } from "./api/auth.js";
import { createJob, uploadFile } from "./api/jobs.js";
import { loadJob, saveJob } from "./jobs/state.js";
import { processJob, retryJob } from "./jobs/processor.js";
import { key, getStream, nodeToWebStream } from "./storage/mega.js";

function withCors(response,env){
  const h=new Headers(response.headers);for(const [k,v] of Object.entries(corsHeaders(env)))h.set(k,v);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
function authOr(env,request){return authorize(request,env);}
function pathParts(url){return url.pathname.split("/").filter(Boolean);}
function methodNot(){return new Response("Method Not Allowed",{status:405});}

async function statusRoute(request,env,jobId){
  const job=await loadJob(env,jobId);if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  return Response.json({
    jobId:job.jobId,status:job.status,totalFiles:job.totalFiles,totalPages:job.totalPages||0,
    processedPages:job.processedPages||0,progress:job.progress||0,currentFile:job.currentFile||"",
    currentPage:job.currentPage||0,error:job.error||null,retryCount:job.retryCount||0,
    createdAt:job.createdAt,startedAt:job.startedAt,completedAt:job.completedAt,
    outputPath:job.status==="completed"?job.outputPath:null,outputPages:job.outputPages||0,
    previewPages:job.status==="completed"?Array.from({length:Math.min(job.outputPages||0,12)},(_,i)=>i+1):[]
  });
}

async function processRoute(request,env){
  let b;try{b=await request.json();}catch{return jsonError("Invalid JSON.");}
  const job=await loadJob(env,b.jobId);if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  if(job.status==="completed")return Response.json({ok:true,status:"completed"});
  const { head } = await import("./storage/mega.js");
  for(const f of job.files){
    const h=await head(env,f.key);
    if(!h)return jsonError(`Upload not found: ${f.name}`,409,"UPLOAD_MISSING");
    if(Number(h.size)!==Number(f.size))return jsonError(`Upload incomplete: ${f.name}`,409,"UPLOAD_INCOMPLETE");
  }
  job.status="queued";job.error=null;await saveJob(env,job);
  await env.PDF_QUEUE.send({jobId:job.jobId});
  return Response.json({ok:true,jobId:job.jobId,status:"queued"});
}

async function cancelRoute(request,env,jobId){
  const job=await loadJob(env,jobId);if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  if(job.status==="completed")return jsonError("Completed jobs cannot be cancelled.",409);
  job.status="cancelled";job.error=null;await saveJob(env,job);
  return Response.json({ok:true,status:"cancelled"});
}

async function retryRoute(request,env,jobId){
  const job=await retryJob(env,jobId,env.PDF_QUEUE);
  if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  return Response.json({ok:true,jobId:jobId,status:"queued"});
}

async function previewRoute(request,env,jobId,page){
  const job=await loadJob(env,jobId);if(!job||job.status!=="completed")return jsonError("Preview not ready.",404,"NOT_READY");
  const n=Number(page);if(!Number.isInteger(n)||n<1||n>job.outputPages)return jsonError("Invalid preview page.",404,"NOT_FOUND");
  const { getBytes } = await import("./storage/mega.js");
  const bytes=await getBytes(env,key.preview(jobId,n));if(!bytes)return jsonError("Preview not found.",404,"NOT_FOUND");
  return new Response(bytes,{headers:{"Content-Type":"image/svg+xml; charset=utf-8","Cache-Control":"public,max-age=86400,immutable"}});
}

async function downloadRoute(request,env,jobId){
  const job=await loadJob(env,jobId);if(!job)return jsonError("Job not found.",404,"NOT_FOUND");
  if(job.status!=="completed")return jsonError("PDF is not ready yet.",409,"NOT_READY");
  const stream=await getStream(env,job.outputPath||key.output(jobId));if(!stream)return jsonError("Final PDF missing.",500,"OUTPUT_MISSING");
  const h=new Headers({"Content-Type":"application/pdf","Cache-Control":"private,max-age=0","Content-Disposition":`attachment; filename="${String(job.downloadName||"BLINK-Notes.pdf").replace(/"/g,"")}"`});
  return new Response(nodeToWebStream(stream),{headers:h});
}

async function cleanup(env){
  // MEGA does not expose an efficient object-list API through this adapter.
  // Job retention is therefore conservative: completed outputs remain until manually removed.
  return;
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS")return withCors(new Response(null,{status:204}),env);
    const url=new URL(request.url);
    if(!url.pathname.startsWith("/api/")){
      return env.ASSETS?.fetch(request) || new Response("BLINK PDF Modifier", {status:200});
    }
    if(!authOr(env,request))return withCors(jsonError("Unauthorized",401,"UNAUTHORIZED"),env);
    try{
      const p=pathParts(url);
      if(p[1]==="jobs"&&request.method==="POST")return withCors(await createJob(request,env),env);
      if(p[1]==="upload"&&request.method==="PUT")return withCors(await uploadFile(request,env),env);
      if(p[1]==="process"&&request.method==="POST")return withCors(await processRoute(request,env),env);
      if(p[1]==="status"&&request.method==="GET"&&p[2])return withCors(await statusRoute(request,env,p[2]),env);
      if(p[1]==="preview"&&request.method==="GET"&&p[2]&&p[3])return withCors(await previewRoute(request,env,p[2],p[3]),env);
      if(p[1]==="download"&&request.method==="GET"&&p[2])return withCors(await downloadRoute(request,env,p[2]),env);
      if(p[1]==="cancel"&&request.method==="POST"&&p[2])return withCors(await cancelRoute(request,env,p[2]),env);
      if(p[1]==="retry"&&request.method==="POST"&&p[2])return withCors(await retryRoute(request,env,p[2]),env);
      return withCors(jsonError("Route not found.",404,"NOT_FOUND"),env);
    }catch(e){
      return withCors(jsonError(e?.message||"Internal error.",500,"INTERNAL_ERROR"),env);
    }
  },
  async queue(batch,env){
    for(const message of batch.messages){
      try{await processJob(env,message.body.jobId,env.PDF_QUEUE);message.ack();}
      catch(e){console.error("Queue processing failed",e);message.retry();}
    }
  },
  async scheduled(event,env,ctx){ctx.waitUntil(cleanup(env));}
};
