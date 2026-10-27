import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLoop,loopPrefix,loopDecision,ownedLoops,stopLoops,buildBenny,checkBennyConfig,selectBennyEvents,bennyGate,threadReplyPlan,reproDisposition,nativeEventIntake} from '../scripts/automation.mjs';
import {owner,loop,config,capabilities} from './fixtures/automation.mjs';
const root={source_channel_id:'C_FIXTURE',ts:'100.0001',event_id:'event-1'};
const verdict={source_channel_id:'C_FIXTURE',ts:'101.0002',thread_ts:'100.0001',author_id:'U_TRIAGE',text:'Confirmed.\n[benny:bug] tracker=https://tracker.example/1'};
const runGate=(source,trigger,MCP)=>new Function('trigger','MCP','return (async()=>{'+source+'})();')(trigger,MCP);
test('loop draft preserves owner, is disabled, silent and does not pin inference',()=>{
 const p=buildLoop(loop);assert.equal(p.job.enabled,false);assert.equal(p.job.sessionTarget,'session:'+owner);assert.equal(p.job.owner.sessionKey,owner);assert.deepEqual(p.job.delivery,{mode:'none'});assert.equal(p.job.failureAlert,false);assert.deepEqual(p.job.pacing,{min:'1m',max:'1h'});assert.equal(p.job.payload.model,undefined);assert.equal(p.job.payload.fallbacks,undefined);assert.equal(p.job.payload.allowUnsafeExternalContent,undefined);
 assert.equal(p.job.declarationKey,buildLoop({...loop}).job.declarationKey);
 assert.notEqual(p.job.declarationKey,buildLoop({...loop,doneWhen:'Different predicate'}).job.declarationKey);
});
test('Main, ambiguous owners, missing predicate, bad deadline and too-fast cadence fail closed',()=>{
 for(const bad of [{ownerSessionKey:'agent:main:main'},{ownerSessionKey:'main'},{doneWhen:''},{deadline:'tomorrow'},{interval:'1s'},{interval:'20'},{interval:'999d'}]) assert.throws(()=>buildLoop({...loop,...bad}));
 const fixed=buildLoop({...loop,interval:'5m'});assert.equal(fixed.job.schedule.everyMs,300000);assert.equal(fixed.job.pacing,undefined);
});
test('owner prefix and filter never remove another owner or spoofed title',()=>{
 const p=loopPrefix(owner),jobs=[{id:'ours',name:p+' task',owner:{sessionKey:owner}},{id:'foreign',name:p+' task',owner:{sessionKey:'agent:main:dashboard:foreign'}},{id:'not-loop',name:'some task',owner:{sessionKey:owner}}];
 assert.deepEqual(ownedLoops(jobs,owner).map(x=>x.id),['ours']);assert.deepEqual(stopLoops(jobs,owner,'ours'),[{action:'remove',jobId:'ours'}]);assert.throws(()=>stopLoops(jobs,owner,'foreign'));
});
test('completion requires evidence and stops exactly this declaration once',()=>{
 assert.throws(()=>loopDecision(loop,{}, {done:true},0),/evidence/);
 const r=loopDecision(loop,{}, {done:true,evidence:'three observed passes'},0);assert.equal(r.action,'remove-self');assert.equal(r.state.terminal,'complete');assert.equal(r.declarationKey,buildLoop(loop).job.declarationKey);assert.equal(loopDecision(loop,r.state,{},0).action,'none');
});
test('loop failure and no-progress terminate; success cadence stays bounded',()=>{
 let state={};for(let i=0;i<2;i++){const r=loopDecision(loop,state,{failed:true},0);assert.equal(r.action,'native-error-backoff');assert.equal(r.in,undefined);state=r.state;}
 assert.equal(loopDecision(loop,state,{failed:true},0).state.terminal,'blocked');
 assert.equal(loopDecision(loop,{}, {},Date.parse(loop.deadline)).state.terminal,'deadline');
 assert.equal(loopDecision(loop,{delayMs:3600000},{progress:false},0).in,'3600000ms');
 assert.equal(loopDecision(loop,{delayMs:3600000,failures:1},{progress:true},0).in,'60000ms');
});
test('Benny emits disabled exact-allowlist job; no model or external delivery',()=>{
 const p=buildBenny(config,capabilities);assert.equal(p.job.enabled,false);assert.equal(p.job.sessionTarget,'isolated');assert.equal(p.job.owner.sessionKey,owner);assert.equal(p.job.failureAlert,false);assert.deepEqual(p.job.delivery,{mode:'none'});assert.deepEqual(p.job.payload.toolsAllow,config.toolsAllow);assert.equal(p.job.payload.model,undefined);assert.equal(p.job.trigger.once,false);assert.equal(p.job.schedule.everyMs,60000);
});
test('missing action, normalized reader, trigger authority or budget blocks setup',()=>{
 for(const [c,cap] of [[{...config,actions:{...config.actions,trackerCompensate:''}},capabilities],[config,{...capabilities,normalizedReaders:[]}],[config,{...capabilities,triggers:false}],[{...config,toolsAllow:['*']},capabilities],[{...config,budgets:{}},capabilities],[{...config,permissions:{}},capabilities]]) assert.throws(()=>checkBennyConfig(c,cap));
 assert.throws(()=>buildBenny({...config,transport:{kind:'event',source:'mcp-events'}},capabilities),/catalog/);
});
test('poll gate calls exact reader with cursor and returns real selected context',async()=>{
 let args;const r=await runGate(bennyGate(config),{state:{version:1,seen:[],cursor:'opaque-before'}},{fixture:{events:async a=>(args=a,{structuredContent:{events:[root],nextCursor:'opaque-after'}})}});
 assert.deepEqual(args,{source_channel_id:'C_FIXTURE',cursor:'opaque-before'});assert.equal(r.fire,true);assert.equal(r.state.cursor,'opaque-after');assert.equal(JSON.parse(r.message).reports[0].thread_ts,'100.0001');
 const quiet=await runGate(bennyGate(config),{state:r.state},{fixture:{events:async()=>({structuredContent:{events:[root],nextCursor:'next'}})}});assert.equal(quiet.fire,false);
});
test('reader failures, malformed responses and oversized batches never become healthy silence',async()=>{
 await assert.rejects(runGate(bennyGate(config),{}, {fixture:{events:async()=>{throw Error('disconnected');}}}),/disconnected/);
 await assert.rejects(runGate(bennyGate(config),{}, {fixture:{events:async()=>({structuredContent:{events:[]}})}}),/cursor/);
 assert.throws(()=>selectBennyEvents(config,Array.from({length:17},(_,i)=>({...root,ts:'100.'+i}))),/16 reports/);
 assert.throws(()=>selectBennyEvents(config,[{...root,ts:''}]),/timestamp/);
});
test('triage ignores replies/wrong channels, dedupes root and does not mutate state',()=>{
 const state=Object.freeze({version:1,seen:Object.freeze([])});const r=selectBennyEvents(config,[root,root,{...verdict},{...root,source_channel_id:'OTHER'}],state);
 assert.equal(JSON.parse(r.message).reports.length,1);assert.deepEqual(state,{version:1,seen:[]});assert.equal(selectBennyEvents(config,[root],r.state).fire,false);
 // Scheduler may discard a failed firing's new state: payload must reconcile external effects too.
 assert.equal(selectBennyEvents(config,[root],state).fire,true);
});
test('repro accepts only a single exact final marker by the trusted author in the same root',()=>{
 const c={...config,phase:'reproduce'};assert.equal(selectBennyEvents(c,[verdict]).fire,true);
 for(const e of [{...verdict,author_id:'U_SPOOF'},{...verdict,source_channel_id:'OTHER'},{...verdict,thread_ts:''},{...verdict,text:'[benny:other]'},{...verdict,text:'[benny:bug]\n[benny:performance]'},{...verdict,text:'prefix [benny:bug]'},{...verdict,text:'[benny:bug]\nextra'},{...verdict,text:'[benny:bug] tracker=http://bad'}]) assert.equal(selectBennyEvents(c,[e]).fire,false);
});
test('stream requires exact approved argv and processes normalized lines without shell execution',async()=>{
 const c={...config,transport:{kind:'stream',connectorId:'fixture-stream',command:['fixture-stream','--ndjson']}};assert.equal(buildBenny(c,capabilities).job.schedule.kind,'stream');
 assert.throws(()=>buildBenny({...c,transport:{...c.transport,command:['sh','-c','unapproved']}},capabilities),/approved/);
 const r=await runGate(bennyGate(c),{streamBatch:JSON.stringify(root)+'\n'+JSON.stringify(root)},{});assert.equal(JSON.parse(r.message).reports.length,1);
 await assert.rejects(runGate(bennyGate(c),{streamBatch:'not-json'},{}));
});
test('reply guard requires explicit permission and exact live parent; never fallback posts',()=>{
 const c={...config,permissions:{...config.permissions,threadReplies:true}},coords={source_channel_id:'C_FIXTURE',thread_ts:'100.0001'},parent={exists:true,deleted:false,channel:'C_FIXTURE',ts:'100.0001'};
 assert.deepEqual(threadReplyPlan(c,coords,parent,'verdict').args,{channel:'C_FIXTURE',thread_ts:'100.0001',text:'verdict'});
 assert.equal(threadReplyPlan(c,coords,parent,'verdict',true).action,'none');
 for(const bad of [{...parent,deleted:true},{...parent,exists:false},{...parent,channel:'OTHER'},{...parent,ts:'101.0002'}]) assert.throws(()=>threadReplyPlan(c,coords,bad,'verdict'));
 assert.throws(()=>threadReplyPlan(config,coords,parent,'verdict'),/authorized/);assert.throws(()=>threadReplyPlan(c,{...coords,thread_ts:''},parent,'verdict'));
});
test('repro ownership and before/after proof block competing or premature fixes',()=>{
 const qualified={controlReady:true,featureMapped:true,baselineRepros:2,mediaConfirmed:true,editAuthorized:true,rootCauseEvidence:true,rejectionWindowClosed:true,afterPasses:2,affectedChecksPass:true,publishAuthorized:true};
 assert.equal(reproDisposition(qualified),'eligible-draft-review-gate');
 for(const [delta,out] of [[{fixOwner:true},'stop-owned'],[{fixArtifact:true},'verify-existing'],[{controlReady:false},'blocked'],[{baselineRepros:1},'no-confirmed-repro'],[{editAuthorized:false},'repro-only'],[{afterPasses:1},'bounded-fix-needs-proof'],[{publishAuthorized:false},'verified-local-only']]) assert.equal(reproDisposition({...qualified,...delta}),out);
});

test('native event transport requires discovered catalog and validates trusted envelope data',()=>{
 const transport={kind:'event',source:'mcp-events',server:'fixture',name:'report.created',arguments:{channel:'C_FIXTURE'}};
 const c={...config,transport},cap={...capabilities,event:true,eventCatalog:[{...transport,normalized:true}]};
 const p=buildBenny(c,cap);assert.equal(p.job.trigger,undefined);assert.deepEqual(p.job.schedule,{kind:'event',source:'mcp-events',options:{server:'fixture',name:'report.created',arguments:{channel:'C_FIXTURE'}}});
 const envelope={eventId:'e1',payload:{profile:'openai-webhook-2026-07-28',bindingId:'fixture-binding',event:{eventId:'e1',name:'report.created',data:root}}};
 assert.equal(nativeEventIntake(c,envelope).fire,true);
 assert.throws(()=>nativeEventIntake(c,{...envelope,eventId:'wrong'}),/envelope/);
 assert.throws(()=>buildBenny(c,{...cap,eventCatalog:[]}),/catalog/);
 assert.throws(()=>buildBenny(c,{...cap,event:false}),/catalog/);
 assert.equal(nativeEventIntake(c,{...envelope,payload:{...envelope.payload,event:{...envelope.payload.event,data:{...root,source_channel_id:'OTHER'}}}}).fire,false);
});
