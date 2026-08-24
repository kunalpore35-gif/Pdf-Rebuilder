import { getDocument } from "pdfjs-serverless";

export async function validatePdfObject(obj, maxPages){
  if(!obj) throw new Error("PDF object not found in R2.");
  const size=Number(obj.size||0);
  if(size<5) throw new Error("PDF is empty or corrupted.");
  // Fast magic-byte validation without loading the whole object.
  const head=new Uint8Array(await obj.body?.getReader().read().then(x=>x.value) || []);
  const sig=new TextDecoder().decode(head.slice(0,5));
  if(sig !== "%PDF-") throw new Error("Uploaded file is not a valid PDF.");
  return {size};
}

export async function countPdfPagesFromBytes(bytes,maxPages){
  const pdf=await getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true}).promise;
  const pages=pdf.numPages;
  if(pages<1) throw new Error("PDF contains no pages.");
  if(pages>maxPages) throw new Error(`PDF contains ${pages} pages; the configured limit is ${maxPages}.`);
  return pages;
}
