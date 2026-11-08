import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../../src/lib/whitepaper.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {parseBlocks}=await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('an article HTTPS image is an image block rather than an exclamation and link',()=>{
 const src='https://mmbiz.qpic.cn/mmbiz_png/example/0?from=appmsg';
 assert.deepEqual(parseBlocks(`Before\n\n![代理记忆结构图](${src})\n\nAfter`,{images:true}),[
 {kind:'paragraph',inline:[{kind:'text',text:'Before'}]},
 {kind:'image',alt:'代理记忆结构图',src},
 {kind:'paragraph',inline:[{kind:'text',text:'After'}]},
 ]);
});
test('local article figures still render and images remain opt-in',()=>{
 const md='![Figure](/figures/example.png)';
 assert.deepEqual(parseBlocks(md,{images:true}),[{kind:'image',alt:'Figure',src:'/figures/example.png'}]);
 assert.equal(parseBlocks(md)[0].kind,'paragraph');
});
test('image sources cannot use executable, insecure or protocol-relative schemes',()=>{
 for(const src of ['javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','http://example.com/a.png','//example.com/a.png']){
  assert.ok(parseBlocks(`![Image](${src})`,{images:true}).every(x=>x.kind!=='image'),src);
 }
});

test('the shared article body emits an actual lazy HTTPS image with its caption as alt',async()=>{
 const {createRequire}=await import('node:module');
 const {Script}=await import('node:vm');
 const require=createRequire(import.meta.url);
 const React=require('react');
 const {renderToStaticMarkup}=require('react-dom/server');
 const component=readFileSync(new URL('../../src/components/editorial-body.tsx',import.meta.url),'utf8');
 const compiled=ts.transpileModule(component,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};
 const localRequire=(id)=>{
  if(id==='@/lib/whitepaper')return {parseBlocks};
  if(id==='@/lib/i18n')return {localizedPath:(_language,path)=>path};
  if(id.endsWith('.css'))return {default:{figure:'figure',body:'body'}};
  if(id==='next/link')return {default:({children,...props})=>React.createElement('a',props,children)};
  return require(id);
 };
 new Script(`(function(require,exports){${compiled}\n})`).runInThisContext()(localRequire,exports);
 const html=renderToStaticMarkup(React.createElement(exports.EditorialBody,{markdown:'![代理记忆结构图](https://mmbiz.qpic.cn/example.png)',language:'zh-CN'}));
 assert.match(html,/<img\b[^>]*src="https:\/\/mmbiz\.qpic\.cn\/example\.png"/);
 assert.match(html,/alt="代理记忆结构图"/);
 assert.match(html,/loading="lazy"/);
 assert.match(html,/referrerPolicy="no-referrer"/);
 assert.doesNotMatch(html,/<a\b/);
});
