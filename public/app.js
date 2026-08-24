(() => {
  const cfg = window.BLINK_CONFIG || {};
  const base = (cfg.WORKER_API_BASE || "").replace(/\/+$/,"");
  const token = cfg.API_AUTH_TOKEN || "";
  const state = { files: [], jobId: null, timer: null };

  const $ = id => document.getElementById(id);
  const log = msg => { $("log").hidden = false; $("log").textContent += msg + "\n"; $("log").scrollTop = $("log").scrollHeight; };
  const headers = () => token ? {"Authorization":`Bearer ${token}`} : {};

  function formatBytes(n){ if(n<1024**2) return `${(n/1024).toFixed(1)} KB`; return `${(n/1024**2).toFixed(1)} MB`; }

  $("dropzone").onclick = () => $("files").click();
  $("files").onchange = e => {
    state.files = [...e.target.files].filter(f => f.type === "application/pdf");
    renderFiles();
    $("generate").disabled = state.files.length === 0;
  };

  function renderFiles(){
    $("fileList").innerHTML = state.files.map((f,i) =>
      `<div class="file"><span>📄 ${escapeHtml(f.name)}</span><small>${formatBytes(f.size)}</small></div>`
    ).join("");
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  async function api(path, options={}){
    const res = await fetch(base + path, { ...options, headers: {...headers(), ...(options.headers||{})}});
    if(!res.ok){
      const t = await res.text();
      throw new Error(`${res.status}: ${t.slice(0,500)}`);
    }
    return res.headers.get("content-type")?.includes("application/json") ? res.json() : res;
  }

  async function createJob(){
    const files = state.files.map(f => ({name:f.name,size:f.size,type:f.type}));
    return api("/api/jobs", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        files,
        formatMode:$("formatMode").value,
        documentMode:$("documentMode").value,
        model:$("model").value.trim(),
        instructions:$("instructions").value
      })
    });
  }

  async function uploadFile(job, file, descriptor){
    const res = await fetch(base+`/api/upload?jobId=${encodeURIComponent(job.jobId)}&fileId=${encodeURIComponent(descriptor.fileId)}`, {
      method:"PUT", headers:{"Content-Type":"application/pdf"}, body:file
    });
    if(!res.ok) throw new Error(`MEGA upload failed for ${file.name}: ${res.status} ${await res.text()}`);
  }

  function setProgress(p,text,current=""){
    $("status").hidden=false;
    $("percent").textContent=`${Math.round(p)}%`;
    $("bar").style.width=`${Math.max(0,Math.min(100,p))}%`;
    $("statusText").textContent=text;
    $("current").textContent=current;
  }

  async function poll(){
    if(!state.jobId) return;
    try{
      const j=await api(`/api/status/${encodeURIComponent(state.jobId)}`);
      setProgress(j.progress||0, j.status, `${j.processedPages||0} / ${j.totalPages||0} pages · ${j.currentFile||""} ${j.currentPage?`page ${j.currentPage}`:""}`);
      if(j.error) log(`ERROR: ${j.error}`);
      if(j.status==="completed"){
        clearInterval(state.timer); state.timer=null;
        $("cancel").disabled=true; $("download").disabled=false;
        $("result").hidden=false;
        $("resultInfo").textContent=`${j.totalPages} source pages → ${j.outputPages} A4 pages`;
        await loadPreview(j.previewPages||[]);
      } else if(j.status==="failed" || j.status==="cancelled"){
        clearInterval(state.timer); state.timer=null; $("cancel").disabled=true;
      }
    }catch(e){ log(`Status error: ${e.message}`); }
  }

  async function loadPreview(pages){
    $("preview").innerHTML="";
    for(const page of pages.slice(0,12)){
      const img=document.createElement("img");
      img.alt=`BLINK preview page ${page}`;
      img.loading="lazy";
      img.src=base+`/api/preview/${encodeURIComponent(state.jobId)}/${page}`;
      $("preview").appendChild(img);
    }
  }

  $("generate").onclick = async () => {
    if(!state.files.length) return;
    $("generate").disabled=true; $("cancel").disabled=false; $("download").disabled=true; $("result").hidden=true; $("log").hidden=true; $("log").textContent="";
    try{
      setProgress(0,"Creating job");
      const job=await createJob();
      state.jobId=job.jobId;
      log(`Job ${job.jobId} created.`);
      for(let i=0;i<state.files.length;i++){
        setProgress((i/state.files.length)*15,"Uploading",`${i+1}/${state.files.length} · ${state.files[i].name}`);
        await uploadFile(job,state.files[i],job.files[i]);
        log(`Uploaded ${state.files[i].name}`);
      }
      await api("/api/process",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:state.jobId})});
      log("Queued for server-side processing.");
      state.timer=setInterval(poll, cfg.POLL_MS || 1500);
      await poll();
    }catch(e){
      log(e.message); setProgress(0,"Failed"); $("cancel").disabled=true;
    }finally{
      $("generate").disabled=false;
    }
  };

  $("cancel").onclick = async () => {
    if(!state.jobId) return;
    try{ await api(`/api/cancel/${encodeURIComponent(state.jobId)}`,{method:"POST"}); }catch(e){log(e.message);}
  };

  $("download").onclick = async () => {
    if(!state.jobId) return;
    const res=await fetch(base+`/api/download/${encodeURIComponent(state.jobId)}`,{headers:headers()});
    if(!res.ok){log(`Download failed: ${res.status}`);return;}
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download="BLINK-Notes.pdf"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  };
})();
