import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const required=[
"public/index.html","public/app.js","public/styles.css","public/config.js",
"src/worker.js","src/api/jobs.js","src/api/auth.js","src/jobs/state.js","src/jobs/processor.js",
"src/pdf/gemini.js","src/pdf/layout.js","src/storage/mega.js","wrangler.toml","package.json",".dev.vars.example","README.md",
"assets/blink-header.png","assets/blink-footer.png","assets/ComicNeue-Regular.otf","assets/ComicNeue-Bold.otf"
];
for(const p of required)if(!fs.existsSync(path.join(root,p)))throw new Error(`Missing ${p}`);
const all=["public/app.js","src/worker.js","src/jobs/processor.js","src/pdf/layout.js"].map(p=>fs.readFileSync(path.join(root,p),"utf8")).join("\n");
for(const bad of ["html2canvas","jsPDF","html2canvas.min.js"])if(all.includes(bad))throw new Error(`Forbidden browser PDF renderer: ${bad}`);
console.log(`BLINK project check passed: ${required.length} required artifacts present.`);
