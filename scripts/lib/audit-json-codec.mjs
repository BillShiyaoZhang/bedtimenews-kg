import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const FORMAT = 'bedtimenews-json-dictionary';
const TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/gu;
const defaults = Object.freeze({ maxEncodedBytes: 128 * 1024 * 1024, maxEnvelopeBytes: 512 * 1024 * 1024, maxDecodedBytes: 512 * 1024 * 1024, maxStrings: 4000000, maxTokens: 20000000, maxDepth: 128 });
const fail = (m) => { throw new Error(`Audit dictionary: ${m}`); };
const hash = b => createHash('sha256').update(b).digest('hex');
function limits(options) { for (const k of Object.keys(options)) if (!(k in defaults) || !Number.isSafeInteger(options[k]) || options[k] < 1 || options[k] > defaults[k]) fail('invalid limits'); return {...defaults,...options}; }
function canonical(v, depth, l) {
 if(depth > l.maxDepth) fail('depth limit');
 if(v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
 if(typeof v === 'number') { if(!Number.isFinite(v)) fail('nonfinite number'); return JSON.stringify(v); }
 if(Array.isArray(v)) return '['+v.map(x=>canonical(x,depth+1,l)).join(',')+']';
 if(typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) fail('invalid object');
 return '{'+Object.keys(v).sort().map(k=>{if(['__proto__','constructor','prototype'].includes(k)) fail('unsafe object key');return JSON.stringify(k)+':'+canonical(v[k],depth+1,l)}).join(',')+'}';
}
function parseCanonical(bytes,l) {
 if(bytes.length > l.maxDecodedBytes) fail('decoded size limit');
 let s; try { s=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch { fail('invalid UTF-8'); }
 let value;try { value=JSON.parse(s); } catch { fail('invalid JSON'); }
 if(canonical(value,0,l)+'\n' !== s) fail('noncanonical JSON');
 return s;
}
/** Self-contained storage encoding. No ancestor or external dictionary exists. */
export function encodeAuditJson(bytes, options={}) {
 const l=limits(options); if(!Buffer.isBuffer(bytes)) fail('Buffer required');
 const source=parseCanonical(bytes,l), dictionary=[], indices=new Map(); let count=0;
 const body=source.replace(TOKEN,token=>{if(++count>l.maxTokens)fail('token limit'); let i=indices.get(token);if(i===undefined){i=dictionary.length;if(i>=l.maxStrings)fail('dictionary limit');indices.set(token,i);dictionary.push(token);}return '~'+i+'~';});
 const payload=Buffer.from(JSON.stringify({format:FORMAT,version:1,decodedBytes:bytes.length,decodedSha256:hash(bytes),dictionary,body}));
 if(payload.length>l.maxEnvelopeBytes)fail('envelope size limit');
 const result=gzipSync(payload,{level:6}); if(result.length>l.maxEncodedBytes)fail('encoded size limit'); return result;
}
export function decodeAuditJson(bytes,options={}) {
 const l=limits(options);if(!Buffer.isBuffer(bytes)||bytes.length>l.maxEncodedBytes)fail('encoded size limit');
 let e;try {const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(gunzipSync(bytes,{maxOutputLength:l.maxEnvelopeBytes}));e=JSON.parse(text);if(JSON.stringify(e)!==text)fail('noncanonical envelope');} catch {fail('invalid gzip/envelope');}
 if(!e || Object.getPrototypeOf(e)!==Object.prototype || Object.keys(e).sort().join(',')!=='body,decodedBytes,decodedSha256,dictionary,format,version' || e.format!==FORMAT||e.version!==1)fail('unsupported envelope');
 if(!Number.isSafeInteger(e.decodedBytes)||e.decodedBytes<1||e.decodedBytes>l.maxDecodedBytes||!/^[a-f0-9]{64}$/.test(e.decodedSha256)||typeof e.body!=='string'||!Array.isArray(e.dictionary)||e.dictionary.length>l.maxStrings)fail('invalid envelope');
 const unique=new Set(), used=new Set(), sizes=[];
 for(const token of e.dictionary){if(typeof token!=='string'||unique.has(token))fail('invalid dictionary');let v;try{v=JSON.parse(token);}catch{fail('invalid string token');}if(typeof v!=='string'||JSON.stringify(v)!==token)fail('noncanonical string token');unique.add(token);sizes.push(Buffer.byteLength(token));}
 if(/["\\]|[^\x00-\x7f]/u.test(e.body))fail('invalid body');
 let size=Buffer.byteLength(e.body),count=0;
 // Count the final decoded length before allocating its string. A reference
 // may be longer than its short token, so intermediate body-plus-delta sizes
 // are not output lengths and must not reject a valid tight bound.
 for(const match of e.body.matchAll(/~([^~]*)~/g)) {
  const id=match[1];
  if(++count>l.maxTokens||!/^(0|[1-9][0-9]*)$/.test(id))fail('invalid reference');
  const i=Number(id);if(!Number.isSafeInteger(i)||i>=e.dictionary.length)fail('invalid reference');
  used.add(i);size+=sizes[i]-id.length-2;
 }
 if(size>l.maxDecodedBytes)fail('decoded size limit');
 if(used.size!==e.dictionary.length||size!==e.decodedBytes)fail('dictionary/size mismatch');
 const source=e.body.replace(/~([^~]*)~/g,(_,id)=>e.dictionary[Number(id)]);
 const result=Buffer.from(source);if(result.length!==e.decodedBytes||hash(result)!==e.decodedSha256)fail('decoded binding mismatch');parseCanonical(result,l);return result;
}
