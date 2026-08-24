import {key,putJson,getJson} from "../storage/mega.js";
import {now} from "../utils/config.js";

export async function loadJob(env,jobId){ return getJson(env,key.job(jobId)); }
export async function saveJob(env,job){ job.updatedAt=now(); await putJson(env,key.job(job.jobId),job); return job; }

export function setProgress(job){
  const total=job.totalPages||0;
  job.progress=total?Math.min(100,Math.round(job.processedPages*100/total)):0;
  return job;
}
export async function checkpoint(env,job,fileId,chunkIndex,payload){
  await putJson(env,key.checkpoint(job.jobId,fileId,chunkIndex),{jobId:job.jobId,fileId,chunkIndex,savedAt:now(),...payload});
}
export async function readCheckpoint(env,job,fileId,chunkIndex){
  return getJson(env,key.checkpoint(job.jobId,fileId,chunkIndex));
}
