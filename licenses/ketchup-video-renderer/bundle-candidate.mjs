const {build,version}=await import(process.env.PSTACK_ESBUILD || 'esbuild');
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
if(version!=='0.28.2')throw Error('wrong esbuild');
const original=process.env.PSTACK_ARTIFACT_SOURCE ? resolve(process.env.PSTACK_ARTIFACT_SOURCE) : null;
await build({entryPoints:['candidate/wasm-binding.ts'],outfile:'candidate/index.mjs',bundle:true,format:'esm',platform:'neutral',define:{'import.meta.url':'undefined'},plugins:[{name:'matched-generated-bindings',setup(b){b.onResolve({filter:/^\.\/wasm\/dist$/},()=>({path:resolve('candidate/index.js')}));}}]});
let r;
if(original) r=await build({entryPoints:[original+'/src/artifacts/ketchup-video/cli.mjs'],outfile:'dist/ketchup-video.mjs',bundle:true,platform:'node',format:'esm',target:'node22',loader:{'.wasm':'binary','.ttf':'binary'},alias:{'@resvg/resvg-wasm':resolve('candidate/index.mjs'),'@resvg/resvg-wasm/index_bg.wasm':resolve('candidate/index_bg.wasm')},legalComments:'eof',metafile:true});
for(const o of Object.values(r?.metafile.outputs || {}))for(const i of o.imports)if(i.external&&!i.path.startsWith('node:'))throw Error('external '+i.path);
const files={};for(const f of ['candidate/index.js','candidate/index.mjs','candidate/index_bg.wasm',...(original ? ['dist/ketchup-video.mjs'] : [])]){const b=await readFile(f);files[f]={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}
await writeFile('candidate-evidence.json',JSON.stringify({files,esbuild:version,sourceEntry:original ? 'PSTACK_ARTIFACT_SOURCE/src/artifacts/ketchup-video/cli.mjs' : null,metafile:r?.metafile},null,2)+'\n');console.log(JSON.stringify(files));
