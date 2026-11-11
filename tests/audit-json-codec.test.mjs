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
