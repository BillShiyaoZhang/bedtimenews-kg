import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const FORMAT = 'bedtimenews-json-dictionary';
const TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/gu;
const defaults = Object.freeze({ maxEncodedBytes: 128 * 1024 * 1024, maxEnvelopeBytes: 512 * 1024 * 1024, maxDecodedBytes: 512 * 1024 * 1024, maxStrings: 4000000, maxTokens: 20000000, maxDepth: 128 });
const fail = (m) => { throw new Error(`Audit dictionary: ${m}`); };
const hash = b => createHash('sha256').update(b).digest('hex');
function limits(options) { for (const k of Object.keys(options)) if (!(k in defaults) || !Number.isSafeInteger(options[k]) || options[k] < 1 || options[k] > defaults[k]) fail('invalid limits'); return {...defaults,...options}; }
// Validate canonical JSON with a bounded cursor stack, not a second ledger AST
// plus a reconstructed full-size JSON string. Only the current string/number
// token and one previous key per open object are retained during validation.
function validateCanonicalText(source, l) {
 const stringToken = new RegExp(TOKEN.source, 'uy');
 const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
 let offset = 0;
 const punctuation = (expected) => {
  if(source[offset] !== expected) fail('invalid JSON');
  offset++;
 };
 function string() {
  stringToken.lastIndex = offset;
  const match = stringToken.exec(source);
  if(!match) fail('invalid JSON string');
  const token = match[0];
  const value = JSON.parse(token);
  if(JSON.stringify(value) !== token) fail('noncanonical JSON string');
  offset = stringToken.lastIndex;
  return value;
 }
 function value(depth) {
  if(depth > l.maxDepth) fail('depth limit');
  const first = source[offset];
  if(first === '"') { string(); return; }
  if(first === '[') {
   offset++;
   if(source[offset] === ']') { offset++; return; }
   while(true) {
    value(depth + 1);
    if(source[offset] === ']') { offset++; return; }
    punctuation(',');
   }
  }
  if(first === '{') {
   offset++;
   if(source[offset] === '}') { offset++; return; }
   let previous;
   while(true) {
    const key = string();
    if(['__proto__','constructor','prototype'].includes(key)) fail('unsafe object key');
    if(previous !== undefined && key <= previous) fail('noncanonical JSON keys');
    previous = key;
    punctuation(':'); value(depth + 1);
    if(source[offset] === '}') { offset++; return; }
    punctuation(',');
   }
  }
  for(const literal of ['null','true','false']) {
   if(source.startsWith(literal, offset)) { offset += literal.length; return; }
  }
  numberToken.lastIndex = offset;
  const match = numberToken.exec(source);
  if(!match) fail('invalid JSON');
  const token = match[0];
  const number = Number(token);
  if(!Number.isFinite(number) || JSON.stringify(number) !== token) fail('noncanonical JSON number');
  offset = numberToken.lastIndex;
 }
 value(0);
 if(offset !== source.length - 1 || source[offset] !== '\n') fail('noncanonical JSON');
}
function parseCanonical(bytes,l) {
 if(bytes.length > l.maxDecodedBytes) fail('decoded size limit');
 let source; try { source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch { fail('invalid UTF-8'); }
 validateCanonicalText(source,l);
 return source;
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
