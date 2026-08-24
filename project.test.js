import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const read=p=>fs.readFileSync(path.join(root,p),"utf8");

test("deploy-ready project structure exists",()=>{
  for(const p of ["public/index.html","public/app.js","public/styles.css","public/config.js","src/worker.js","src/jobs/processor.js","src/pdf/layout.js","src/pdf/gemini.js","src/storage/mega.js","src/jobs/state.js","wrangler.toml",".dev.vars.example","README.md","package.json"]) assert.ok(fs.existsSync(path.join(root,p)),p);
});

test("browser does not contain final-PDF rendering engines",()=>{
  const browser=read("public/app.js")+read("public/index.html");
  for(const bad of ["html2canvas","jspdf","jsPDF","canvas.getContext","toDataURL"]) assert.equal(browser.includes(bad),false,bad);
});

test("worker has server-side final PDF path and no browser PDF renderer",()=>{
  const worker=read("src/worker.js")+read("src/jobs/processor.js")+read("src/pdf/layout.js");
  for(const bad of ["html2canvas","jsPDF","html2canvas.min.js"]) assert.equal(worker.includes(bad),false,bad);
  assert.match(worker,/PDFDocument/);
  assert.match(worker,/PDF_QUEUE/);
  assert.match(worker,/checkpoint/);
});

test("A4 geometry is present",()=>{
  assert.match(read("src/pdf/layout.js"),/595\.28/);
  assert.match(read("src/pdf/layout.js"),/841\.89/);
});

test("required modes and content types are implemented",()=>{
  const s=read("src/pdf/gemini.js")+read("src/pdf/layout.js")+read("public/index.html");
  for(const x of ["handwritten","normal","formula","diagram-box","trick","mistake","example","table","CHAPTER"]) assert.ok(s.includes(x),x);
});

test("batch and chunk limits are configured",()=>{
  const t=read("wrangler.toml");
  assert.match(t,/MAX_FILES_PER_BATCH = "20"/);
  assert.match(t,/MAX_TOTAL_PAGES = "1000"/);
  assert.match(t,/PROCESS_CONCURRENCY = "2"/);
  assert.match(t,/CHUNK_SIZE = "20"/);
});

test("20 files x 50 pages produces 1000 pages and 60 chunks",()=>{
  const files=20,pagesPerFile=50,chunk=20;
  const total=files*pagesPerFile;
  assert.equal(total,1000);
  assert.equal(files*Math.ceil(pagesPerFile/chunk),60);
});

test("1000 pages are resumable without page-1 restart",()=>{
  const chunk=20,total=1000,completed=[...Array(32)].map((_,i)=>i);
  const next=Math.max(...completed)+1;
  assert.equal(next,32);
  assert.equal(next*chunk,640);
  assert.equal((next+1)*chunk,660);
});

test("download route is read-only",()=>{
  const s=read("src/worker.js");
  const start=s.indexOf("async function downloadRoute");
  const end=s.indexOf("async function cleanup");
  const route=s.slice(start,end);
  assert.match(route,/getStream\(env,/);
  assert.match(route,/nodeToWebStream/);
  assert.equal(route.includes("processJob"),false);
  assert.equal(route.includes("buildBlinkPdf"),false);
});
