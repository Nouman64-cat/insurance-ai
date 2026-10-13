import fs from 'node:fs/promises';
import {Presentation,PresentationFile} from '@oai/artifact-tool';
import {finalizePresentation} from '/Users/noumanejaz/.codex/plugins/cache/openai-primary-runtime/presentations/26.1011.11113/skills/presentations/container_tools/artifact_tool_utils.mjs';
const root='/Users/noumanejaz/Desktop/projects/insurance-ai';
const skill='/Users/noumanejaz/.codex/plugins/cache/openai-primary-runtime/presentations/26.1011.11113/skills/presentations';
const p=Presentation.create({slideSize:{width:1600,height:900}});
const C={bg:'#F5F7FB',ink:'#102D49',blue:'#1769AA',teal:'#007F86',muted:'#52677B',white:'#FFFFFF'};
function text(s,t,x,y,w,h,size=26,color=C.ink,bold=false,fill='none',align='left'){
 const a=s.shapes.add({geometry:fill==='none'?'textbox':'roundRect',position:{left:x,top:y,width:w,height:h},fill,line:{fill:fill==='none'?'none':'#D8E2EB',width:fill==='none'?0:1}});
 a.text=t;a.text.style={fontFamily:'Arial',fontSize:size,color,bold,alignment:align,verticalAlignment:'middle'};return a;
}
function slide(title,sub,n){const s=p.slides.add();s.background.fill=C.bg;text(s,title,70,40,1460,65,44,C.ink,true);text(s,sub,70,112,1460,48,24,C.muted);text(s,'Insurance AI',70,855,450,25,18,C.muted);text(s,String(n).padStart(2,'0'),1450,850,70,30,20,C.muted,false,'none','right');return s;}
function connect(s,a,b,from='right',to='left',both=false){s.shapes.connect(a,b,{kind:'straight',fromSide:from,toSide:to,line:{fill:C.blue,width:3},tail:{type:'arrow'},...(both?{head:{type:'arrow'}}:{})});}
const s1=slide('Integration with existing infrastructure','Insurance AI connects through secure APIs and dedicated connectors',1);
const hub=text(s1,'INSURANCE AI\n\nUnderwriting, policies, claims\nand commission workflows',565,310,470,260,32,C.white,true,C.ink,'center');
const endpoints=[['Existing CRM','Customer profiles and relationships',70,210],['NADRA','Authorized identity verification',70,440],['Sanctions / PEP','Screening provider integration',70,670],['Core insurance / ERP','Policy and finance systems',1110,210],['Banks / payment gateways','Collections and payment status',1110,440],['Document / email systems','Evidence and communications',1110,670]];
for(const [a,b,x,y] of endpoints){const node=text(s1,a+'\n'+b,x,y,420,120,25,C.ink,true,C.white,'center');connect(s1,x<500?node:hub,x<500?hub:node,x<500?'right':'right',x<500?'left':'left',true);}
text(s1,'Connector setup and provider authorization required. External integrations shown are not all live today.',70,805,1460,38,21,C.muted);
s1.speakerNotes.text='Conceptual integration architecture based on the current repository APIs, tenant isolation and events. No live NADRA integration is claimed. CRM and other connectors require implementation and authorized access. SSO handles staff access separately from system integrations.';
const s2=slide('Functional modules','15 existing functional areas, with Request Management planned as a separate module',2);
const groups=[['Acquisition & operations',['Customer & lead management','Applications & proposals','Policy lifecycle management','Premiums & collections','Claims management']],['Intelligence & decisions',['Underwriting','Risk intelligence','Rules & decision engine','Document intelligence','Fraud intelligence']],['Distribution & platform',['Group & family insurance','Commission engine','Automation chat & voice','Dashboards & reporting','Platform administration']]];
groups.forEach(([heading,items],col)=>{const x=70+col*500;text(s2,heading,x,205,460,55,29,C.teal,true);items.forEach((t,i)=>{text(s2,String(col*5+i+1).padStart(2,'0'),x,290+i*80,48,60,23,C.blue,true);text(s2,t,x+60,290+i*80,405,60,27);});});
text(s2,'Planned: Request Management',70,728,1460,52,29,C.teal,true);
text(s2,'Implementation maturity varies. Commission is partial, and some dashboard/reporting views use illustrative data.',70,797,1460,44,21,C.muted);
s2.speakerNotes.text='Functional grouping based on the current insurance-ai repository and discussion. Module presence does not imply production readiness. Request Management is planned, not implemented. Underwriting and Automation Chat have separate frontends. This is a functional inventory, not a microservice count.';
const s3=slide('Insurance workflow shared by Faraz sb','Sequence as shared, from lead generation through policy closure',3);
const phases=[['01  Acquisition',['Lead Generation','Customer Acquisition','Quotation / Premium Illustration','Premium Collection','Proposal Submission','Document Collection']],['02  Assessment & issuance',['OCR & AI Validation','Medical Underwriting','Financial Underwriting','Fraud & Risk Analysis','Underwriter Decision','Policy Issuance']],['03  Servicing & settlement',['Commission Processing','Customer Servicing','Surrender on maturity / before maturity / customer death or disability','Claims Processing','Policy Closure / Maturity / Surrender']]];
const nodes=[];
phases.forEach(([heading,items],col)=>{const x=70+col*510;text(s3,heading,x,192,470,55,29,C.teal,true);items.forEach((t,i)=>{const h=(col===2&&i===2)?116:65;let y=275+i*84;if(col===2&&i>2)y+=51;const node=text(s3,t,x,y,455,h,(col===2&&i===2)?24:25,C.ink,false,C.white,'center');nodes.push({node,col,i});if(i>0)connect(s3,nodes[nodes.length-2].node,node,'bottom','top');});});
// Cross-column links use the clear gutters and horizontal space above/below stages.
text(s3,'Operational note: maturity, surrender, and death/disability follow different settlement paths. Sequence retained as shared.',70,802,1460,42,21,C.muted);
s3.speakerNotes.text='Source: workflow supplied by the user and attributed to Faraz sb. All 17 steps retained in their supplied order. The surrender/death/disability label reflects the supplied wording. In operational design, surrender, maturity benefits and death/disability claims are separate branches rather than a universal linear sequence.';
for(let i=0;i<3;i++){const blob=await p.export({slide:p.slides.items[i],format:'png',scale:1});await fs.writeFile(root+'/.codex-ppt-build/slide-'+(i+1)+'.png',new Uint8Array(await blob.arrayBuffer()));}
const candidate=root+'/.codex-ppt-build/candidate.pptx';await(await PresentationFile.exportPptx(p)).save(candidate);
await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath:root+'/output/presentations/Insurance-AI-Overview.pptx',pythonExecutable:'/Users/noumanejaz/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',integrityValidatorPath:skill+'/container_tools/inspect_presentation_package_integrity.py',layoutValidatorPath:skill+'/container_tools/inspect_presentation_layout_geometry.py',layoutArgs:['--expected-slide-size-emu','15240000,8572500','--validate-heading-fit'],explicitTotalSlideCount:3,fontPolicy:{basis:'design',families:['Aptos']},verifyArtifactToolImport:true,receiptPath:root+'/.codex-ppt-build/validation.json'});
console.log('DONE');
