import test from 'node:test';import assert from 'node:assert/strict';import {gzipSync,gunzipSync} from 'node:zlib';import {encodeAuditJson,decodeAuditJson} from '../scripts/lib/audit-json-codec.mjs';
const b=Buffer.from('{"a":["重复",null,true,1,"~0~","\\\""],"b":"重复"}\n');
const mutate=fn=>{let e=JSON.parse(gunzipSync(encodeAuditJson(b)));fn(e);return gzipSync(JSON.stringify(e));};
test('exact canonical bytes round trip, unicode and escaped delimiters',()=>assert.deepEqual(decodeAuditJson(encodeAuditJson(b)),b));
test('deterministic encoding',()=>assert.deepEqual(encodeAuditJson(b),encodeAuditJson(b)));
for(const [name,fn] of Object.entries({version:e=>e.version=2,unknown:e=>e.extra=1,range:e=>e.body='~99999~',negative:e=>e.body='~-1~',decimal:e=>e.body='~0.1~',leadingZero:e=>e.body='~01~',unterminated:e=>e.body='~0',unused:e=>e.dictionary.push('"unused"'),duplicate:e=>e.dictionary.push(e.dictionary[0]),notString:e=>e.dictionary[0]='1',invalidToken:e=>e.dictionary[0]='"unterminated',badHash:e=>e.decodedSha256='0'.repeat(64),badSize:e=>e.decodedBytes++,rawString:e=>e.body='"raw"',rawUnicode:e=>e.body='中文'}))test(name+' rejected',()=>assert.throws(()=>decodeAuditJson(mutate(fn))));
test('noncanonical/duplicate JSON keys rejected',()=>{for(const x of ['{"b":1,"a":2}\n','{"a":1,"a":2}\n','{"a":1e2}\n'])assert.throws(()=>encodeAuditJson(Buffer.from(x)));});
test('prototype keys rejected without pollution',()=>{assert.throws(()=>encodeAuditJson(Buffer.from('{"__proto__":{"polluted":true}}\n')));assert.equal({}.polluted,undefined);});
test('tight limits rejected',()=>{for(const k of ['maxEncodedBytes','maxEnvelopeBytes','maxDecodedBytes','maxStrings','maxTokens','maxDepth'])assert.throws(()=>decodeAuditJson(encodeAuditJson(b),{[k]:1}));});
test('limits cannot be expanded',()=>assert.throws(()=>decodeAuditJson(encodeAuditJson(b),{maxDepth:129})));
test('deep JSON rejected',()=>assert.throws(()=>encodeAuditJson(Buffer.from('['.repeat(130)+'0'+']'.repeat(130)+'\n'))));
test('malformed gzip and UTF8 rejected',()=>{assert.throws(()=>decodeAuditJson(Buffer.from('bad')));assert.throws(()=>decodeAuditJson(gzipSync(Buffer.from([255]))));});
test('finite primitive roots supported',()=>{for(const s of ['null\n','true\n','12\n','"word"\n'])assert.equal(decodeAuditJson(encodeAuditJson(Buffer.from(s))).toString(),s)});

test('duplicate envelope fields rejected',()=>{const e=gunzipSync(encodeAuditJson(b)).toString();assert.throws(()=>decodeAuditJson(gzipSync(e.replace('{','{"version":1,'))))});

test('UTF8 BOM rejected rather than silently stripped',()=>{assert.throws(()=>encodeAuditJson(Buffer.concat([Buffer.from([239,187,191]),b])));assert.throws(()=>decodeAuditJson(gzipSync(Buffer.concat([Buffer.from([239,187,191]),gunzipSync(encodeAuditJson(b))]))));});

test('tight decoded bound uses final length, not longer dictionary references',()=>{
 const bytes=Buffer.from(JSON.stringify(Array.from('abcdefghijklmnopqrstuvwxyz'))+'\n');
 const encoded=encodeAuditJson(bytes);
 assert.deepEqual(decodeAuditJson(encoded,{maxDecodedBytes:bytes.length}),bytes);
 assert.throws(()=>decodeAuditJson(encoded,{maxDecodedBytes:bytes.length-1}));
});

// These bytes were produced by the unchanged 825cbc05 v1 encoder under the
// pinned runtime. The cursor validator must not change its wire format.
test('cursor validation preserves frozen original encoder bytes', async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/audit-json-codec-v1-bytes.json',import.meta.url),'utf8'));
 for(const {source,encodedBase64} of fixture.vectors){
  const bytes=Buffer.from(source), encoded=Buffer.from(encodedBase64,'base64');
  assert.deepEqual(encodeAuditJson(bytes),encoded);
  assert.deepEqual(decodeAuditJson(encoded),bytes);
 }
});

// Deliberately bypass the encoder only in this test to give the decoder a
// correctly hash-bound envelope containing invalid/noncanonical source JSON.
async function uncheckedEnvelope(source){
 const {createHash}=await import('node:crypto');
 const dictionary=[],indices=new Map();
 const body=source.replace(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/gu,token=>{
  if(!indices.has(token)){indices.set(token,dictionary.length);dictionary.push(token);}
  return `~${indices.get(token)}~`;
 });
 return gzipSync(JSON.stringify({format:'bedtimenews-json-dictionary',version:1,decodedBytes:Buffer.byteLength(source),decodedSha256:createHash('sha256').update(source).digest('hex'),dictionary,body}));
}

test('cursor rejects malformed or noncanonical source at both boundaries',async()=>{
 const invalid=[
  '', '\n', 'null', 'null\n\n', ' null\n', 'null \n', 'null\r\n', 'truefalse\n',
  '[1,]\n','[,1]\n','[1 2]\n','[1\n','{"a":}\n','{"a"1}\n','{"a":1,}\n',
  '{"a":1,"a":2}\n','{"b":1,"a":2}\n','{"2":1,"10":2}\n',
  '{"a":{"b":1,"a":2}}\n','{"a":[{"constructor":1}]}\n','{"prototype":1}\n',
  '-0\n','01\n','1.0\n','1e2\n','1e21\n','1E+21\n','1e+021\n','0.0000001\n','1e400\n','1e-400\n','NaN\n','+1\n','.1\n','1.\n',
  '"\\/"\n','"\\u0061"\n','"\\u000A"\n','"\\ud83d\\ude00"\n','"\\uD800"\n','"unterminated\n','"bad\\x"\n','"raw\tcontrol"\n'
 ];
 for(const source of invalid){
  assert.throws(()=>encodeAuditJson(Buffer.from(source)),source);
  const encoded=await uncheckedEnvelope(source);
  assert.throws(()=>decodeAuditJson(encoded),source);
 }
});


test('cursor depth boundary matches legacy value depth including empty containers',async()=>{
 const exact='['.repeat(128)+'0'+']'.repeat(128)+'\n';
 assert.deepEqual(decodeAuditJson(encodeAuditJson(Buffer.from(exact))),Buffer.from(exact));
 const excessive='['.repeat(129)+'0'+']'.repeat(129)+'\n';
 assert.throws(()=>encodeAuditJson(Buffer.from(excessive)),/depth/u);
 const encoded=await uncheckedEnvelope(excessive);
 assert.throws(()=>decodeAuditJson(encoded),/depth/u);
 for(const source of ['[0]\n','[[]]\n','{"a":{}}\n']) assert.deepEqual(decodeAuditJson(encodeAuditJson(Buffer.from(source),{maxDepth:1}),{maxDepth:1}),Buffer.from(source));
 assert.throws(()=>encodeAuditJson(Buffer.from('[[0]]\n'),{maxDepth:1}),/depth/u);
});

test('cursor checks UTF8 before token parsing',()=>{
 for(const bytes of [Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0xf0,0x28,0x8c,0x28])]) assert.throws(()=>encodeAuditJson(bytes),/UTF-8/u);
});

test('bounded replacement preserves legacy wire bytes across output block boundaries',async()=>{
 const sources=[
  // No string tokens: the entire literal span crosses several output blocks.
  JSON.stringify(Array.from({length:40000},()=>0))+'\n',
  // Many short matches: references and separators fill multiple blocks.
  JSON.stringify(Array.from({length:20000},(_,i)=>`value-${i%31}`))+'\n',
  // One large replacement, with a surrogate pair split exactly at 64 Ki.
  JSON.stringify('x'.repeat(65534)+'😀'+'中'.repeat(65536)+'\\"')+'\n',
  // Exact and adjacent boundaries, including an escaped quote in the token.
  ...[65535,65536,65537].map(n=>JSON.stringify('x'.repeat(n)+'"')+'\n'),
 ];
 for(const source of sources){
  const bytes=Buffer.from(source);
  const encoded=encodeAuditJson(bytes);
  // The fixture-only legacy global replacement builds the identical envelope.
  assert.deepEqual(encoded,await uncheckedEnvelope(source));
  assert.deepEqual(decodeAuditJson(encoded),bytes);
 }
});

test('chunked scanning preserves exact token and dictionary limits',()=>{
 const source=Buffer.from(JSON.stringify(Array.from({length:18000},(_,i)=>`value-${i%3}`))+'\n');
 const encoded=encodeAuditJson(source,{maxTokens:18000,maxStrings:3});
 assert.deepEqual(decodeAuditJson(encoded,{maxTokens:18000,maxStrings:3}),source);
 assert.throws(()=>encodeAuditJson(source,{maxTokens:17999}),/token limit/u);
 assert.throws(()=>encodeAuditJson(source,{maxStrings:2}),/dictionary limit/u);
 assert.throws(()=>decodeAuditJson(encoded,{maxTokens:17999}),/reference/u);
 assert.throws(()=>decodeAuditJson(encoded,{maxStrings:2}),/envelope/u);
});


test('decoded text validation preserves Unicode scalar and escaped-surrogate checks', async()=>{
 for(const value of ['😀', '\ud800', '\udfff', 'a\ud800b', '\ufffd']) {
  const source=JSON.stringify(value)+'\n';
  assert.deepEqual(decodeAuditJson(await uncheckedEnvelope(source)),Buffer.from(source));
 }
 // These malicious envelopes are correctly hash-bound to UTF-8 replacement
 // bytes, but their dictionary tokens contain noncanonical raw surrogates.
 for(const source of ['"\ud800"\n','"\udfff"\n','"a\ud800b"\n']) {
  const encoded=await uncheckedEnvelope(source);
  assert.throws(()=>decodeAuditJson(encoded));
 }
});
