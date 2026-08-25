import mega from "megajs";

let cached = null;
let rootFolder = null;

function errText(e) { return e?.message || String(e); }

async function getStorage(env) {
  if (cached?.status === "ready") return cached;
  if (!env.MEGA_EMAIL || !env.MEGA_PASSWORD) throw new Error("MEGA_EMAIL and MEGA_PASSWORD secrets are required.");
  const storage = mega({
    email: env.MEGA_EMAIL,
    password: env.MEGA_PASSWORD,
    keepalive: false,
    autoload: true,
    autologin: true,
    fetch: globalThis.fetch.bind(globalThis)
  });
  await storage.ready;
  cached = storage;
  return storage;
}

async function ensureFolder(parent, name) {
  const existing = parent.children?.find(x => x.name === name && x.directory);
  if (existing) return existing;
  return parent.mkdir({name});
}

async function getRootFolder(env) {
  if (rootFolder) return rootFolder;
  const storage = await getStorage(env);
  const name = String(env.MEGA_ROOT_FOLDER || "BLINK-PDF-Modifier").replace(/[\\/]/g, "_").slice(0,80) || "BLINK-PDF-Modifier";
  rootFolder = await ensureFolder(storage.root, name);
  return rootFolder;
}

function parts(k) { return String(k).split('/').filter(Boolean); }

async function parentFor(env, key, create=true) {
  const storage = await getStorage(env);
  let node = await getRootFolder(env);
  const ps = parts(key);
  ps.pop();
  for (const part of ps) {
    let next = node.children?.find(x => x.name === part && x.directory);
    if (!next && create) next = await ensureFolder(node, part);
    if (!next) return null;
    node = next;
  }
  return node;
}

async function findNode(env, key) {
  const storage = await getStorage(env);
  let node = await getRootFolder(env);
  for (const part of parts(key)) {
    node = node.children?.find(x => x.name === part);
    if (!node) return null;
  }
  return node;
}

export const key = {
  job: id => `jobs/${id}/job.json`,
  input: (id,fileId) => `jobs/${id}/input/${fileId}.pdf`,
  checkpoint: (id,fileId,chunk) => `jobs/${id}/checkpoint/${fileId}/${chunk}.json`,
  output: id => `jobs/${id}/output/result.pdf`,
  preview: (id,page) => `jobs/${id}/preview/${page}.svg`
};

export async function putJson(env,k,value) {
  const parent = await parentFor(env,k,true);
  const name = parts(k).at(-1);
  const existing = parent.children?.find(x => x.name === name && !x.directory);
  if (existing) await existing.delete(true);
  const file = await parent.upload({name, size: Buffer.byteLength(JSON.stringify(value)), attributes:{n:name}}, Buffer.from(JSON.stringify(value)));
  await file.complete;
  return file;
}

export async function getJson(env,k) {
  const node = await findNode(env,k);
  if (!node || node.directory) return null;
  const bytes = await node.downloadBuffer({maxConnections:1});
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

export async function putBytes(env,k,bytes,type='application/octet-stream') {
  const parent = await parentFor(env,k,true);
  const name = parts(k).at(-1);
  const existing = parent.children?.find(x => x.name === name && !x.directory);
  if (existing) await existing.delete(true);
  const file = await parent.upload({name, size: bytes.byteLength || bytes.length, attributes:{n:name, c:type}}, Buffer.from(bytes));
  await file.complete;
  return file;
}

export async function putStream(env,k,stream,size,type='application/octet-stream') {
  const parent = await parentFor(env,k,true);
  const name = parts(k).at(-1);
  const existing = parent.children?.find(x => x.name === name && !x.directory);
  if (existing) await existing.delete(true);
  const upload = parent.upload({name, size, attributes:{n:name, c:type}}, null);
  const reader = stream?.getReader ? stream.getReader() : null;
  if (!reader) throw new Error('Upload body stream is unavailable.');
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      if (value?.byteLength) upload.write(Buffer.from(value));
    }
    upload.end();
    return await upload.complete;
  } catch (e) {
    try { upload.destroy(e); } catch {}
    throw e;
  }
}

export async function head(env,k) {
  const node = await findNode(env,k);
  if (!node || node.directory) return null;
  return {size:Number(node.size||0), name:node.name};
}

export async function getStream(env,k) {
  const node = await findNode(env,k);
  if (!node || node.directory) return null;
  return node.download({maxConnections:1});
}

export async function getBytes(env,k) {
  const node = await findNode(env,k);
  if (!node || node.directory) return null;
  return new Uint8Array(await node.downloadBuffer({maxConnections:1}));
}

export async function deleteIf(env,k) {
  try {
    const node = await findNode(env,k);
    if (node) await node.delete(true);
  } catch {}
}

export function invalidateMegaCache() {
  try { cached?.close?.(); } catch {}
  cached = null;
  rootFolder = null;
}

export function nodeToWebStream(nodeStream) {
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => { if (!closed) { closed=true; controller.close(); } };
      nodeStream.on('data', chunk => { if (!closed) controller.enqueue(new Uint8Array(chunk)); });
      nodeStream.on('end', close);
      nodeStream.on('error', e => { if (!closed) { closed=true; controller.error(e); } });
    },
    cancel() { try { nodeStream.destroy?.(); } catch {} }
  });
}

export async function getAccountInfo(env) {
  const storage = await getStorage(env);
  return storage.getAccountInfo();
}
