#!/usr/bin/env node
/** Read installed code only, construct schemas, validate fixtures. NEVER call tool.execute. */
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildLoop,buildBenny} from './automation.mjs';
import {loop,config,capabilities} from '../tests/fixtures/automation.mjs';
const runtime=resolve(process.argv[2]??'');
if(!process.argv[2]) throw Error('Usage: node verify_runtime.mjs <installed-openclaw-package>');
const dist=join(runtime,'dist'), files=await readdir(dist);
async function exported(prefix,symbol) {
 for(const name of files.filter(n=>n.startsWith(prefix)&&n.endsWith('.mjs'))) {
  const source=await readFile(join(dist,name),'utf8');
  const exp=source.slice(source.lastIndexOf('export {'));
  const match=new RegExp('\\b'+symbol+' as ([A-Za-z_$][\\w$]*)\\b').exec(exp);
  if(match) return {file:join(dist,name),key:match[1],hash:createHash('sha256').update(source).digest('hex'),module:await import(pathToFileURL(join(dist,name)))};
 }
 throw Error('Installed export unavailable: '+symbol);
}
const toolRef=await exported('cron-tool-','createCronTool');
const tool=toolRef.module[toolRef.key]({agentSessionKey:'agent:main:dashboard:fixture'}, {callGatewayTool:()=>{throw Error('Forbidden live invocation');}});
const addRef=await exported('src-','validateCronAddParams');
const normalizeRef=await exported('normalize-','normalizeCronJobCreate');
const validate=addRef.module[addRef.key], normalize=normalizeRef.module[normalizeRef.key];
const kinds=tool.parameters.properties.job.properties.schedule.properties.kind.enum;
const drafts=[buildLoop(loop),buildLoop({...loop,interval:'5m'}),buildBenny(config,capabilities),buildBenny({...config,phase:'reproduce'},capabilities),buildBenny({...config,transport:{kind:'stream',connectorId:'fixture-stream',command:['fixture-stream','--ndjson']}},capabilities)];
if(kinds.includes('event')) {
 const transport={kind:'event',source:'mcp-events',server:'fixture',name:'report.created',arguments:{channel:'C_FIXTURE'}};
 drafts.push(buildBenny({...config,transport},{...capabilities,event:true,eventCatalog:[{...transport,normalized:true}]}));
}
for(const draft of drafts) {
 const n=normalize(draft.job);
 assert.equal(validate(n),true,JSON.stringify(validate.errors));
 assert.equal(n.enabled,false); assert.equal(n.delivery.mode,'none'); assert.equal(n.payload.model,undefined);
}
for(const bad of [{...drafts[0].job,schedule:{kind:'event',source:''}},{...drafts[0].job,payload:{kind:'made-up'}}]) assert.equal(validate(normalize(bad)),false,'invalid payload must fail protocol');
assert.ok(kinds.includes('stream'));assert.ok(tool.parameters.properties.action.enum.includes('next_check'));
const version=JSON.parse(await readFile(join(runtime,'package.json'),'utf8')).version;
const receipt={ok:true,runtime,version,tool:tool.name,scheduleKinds:kinds,actions:tool.parameters.properties.action.enum,
  fixtureDraftsValidated:drafts.length,negativeProtocolChecks:2,calledExecute:false,schedulerWrites:0,
  schemaModules:[toolRef,addRef,normalizeRef].map(({file,hash})=>({file,sha256:hash})),
  distinction:'Installed pure schema/normalizer proof only; no live tool admission, scheduler execution, connector or delivery tested.'};
console.log(JSON.stringify(receipt,null,2));
