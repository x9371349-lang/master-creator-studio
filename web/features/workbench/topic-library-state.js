// Local workspace data only. These helpers do not call models, fetch or persist.
export const STATUS={candidate:'待选',selected:'已选定',writing:'创作中',drafted:'已成稿',archived:'已归档'};
const limits={title:160,angle:1000,reader:200,premise:2000,material:12000,evidenceGaps:2000};
const labels={title:'名称',angle:'写作角度',reader:'目标读者',premise:'核心观点',material:'素材与笔记',evidenceGaps:'待核实项'};
const stamp=()=>new Date().toISOString();
function clean(value,key,required=false){
  if(value!==undefined && typeof value!=='string')throw new Error('选题字段必须为文字。');
  const text=String(value || '').trim();if(required && !text)throw new Error('请填写选题名称。');
  if(Array.from(text).length>limits[key])throw new Error(`“${labels[key]}”超过 ${limits[key]} 字限制，请精简后保存。`);return text;
}
export function safeSourceURL(value){
  if(!value)return '';try{const url=new URL(String(value));return ['https:','http:'].includes(url.protocol) && !url.username && !url.password && url.href.length<=2000?url.href:'';}catch{return '';}
}
export function ensureLibrary(data){
  if(!data.topicLibrary)data.topicLibrary={schemaVersion:1,topics:[]};
  if(data.topicLibrary.schemaVersion!==1 || !Array.isArray(data.topicLibrary.topics))throw new Error('选题库格式无法读取，请先导出工作台备份。');
  return data.topicLibrary;
}
export const getTopic=(data,id)=>ensureLibrary(data).topics.find(topic=>topic.id===id);
function needTopic(data,id){const topic=getTopic(data,id);if(!topic)throw new Error('选题不存在或已在另一窗口变化，请刷新后重试。');return topic;}
export function createTopic(data,input){
  const fields=Object.fromEntries(Object.keys(limits).map(key=>[key,clean(input[key],key,key==='title')]));
  const raw=input.source || {},url=safeSourceURL(raw.url);
  if(raw.url && !url)throw new Error('来源链接需要完整的 HTTP / HTTPS 地址，且不能包含登录凭据。');
  const sourceText=clean(raw.text ?? fields.material,'material');
  const source={title:String(raw.title || fields.title).slice(0,240),url,document_id:String(raw.document_id || '').slice(0,160),
    document_version:Number.isFinite(Number(raw.document_version))?Number(raw.document_version):0,text:sourceText,captured_at:stamp()};
  const now=stamp(),topic={id:crypto.randomUUID(),...fields,source,status:'candidate',links:{sessionIds:[],draftIds:[]},createdAt:now,updatedAt:now};
  ensureLibrary(data).topics.unshift(topic);return topic;
}
export function updateTopic(data,id,patch){
  const topic=needTopic(data,id),values={};
  if(Object.keys(patch).some(key=>!Object.hasOwn(limits,key)))throw new Error('选题状态、来源快照和稿件关联需通过对应操作更新。');
  for(const key of Object.keys(patch))values[key]=clean(patch[key],key,key==='title');
  Object.assign(topic,values,{updatedAt:stamp()});return topic;
}
export function setTopicStatus(data,id,status){
  if(!['candidate','selected','archived'].includes(status))throw new Error('创作中和已成稿状态由实际会话与稿件更新。');
  const topic=needTopic(data,id);
  if(status==='selected' && topic.status==='archived')throw new Error('请先恢复已归档选题。');
  topic.status=status;topic.updatedAt=stamp();return topic;
}
export function linkScene(data,id,sessionId){
  const topic=needTopic(data,id),session=data.sessions.find(s=>s.id===sessionId);
  if(!session || session.workflow?.topic_id!==id)throw new Error('创作会话尚未关联此选题。');
  if(topic.status==='archived')throw new Error('请先恢复已归档选题。');
  topic.links ||= {sessionIds:[],draftIds:[]};topic.links.sessionIds=[...new Set([...(topic.links.sessionIds || []),sessionId])];
  topic.status=topic.links.draftIds?.length?'drafted':'writing';topic.updatedAt=stamp();return topic;
}
export function linkDraft(data,id,draftId,{sessionId}={}){
  const topic=needTopic(data,id),session=data.sessions.find(s=>s.id===sessionId);
  if(!data.drafts.some(d=>d.id===draftId) || !session || session.workflow?.topic_id!==id || !topic.links.sessionIds.includes(sessionId))throw new Error('只有此选题实际生成并合入工作区的稿件才能关联。');
  topic.links.draftIds=[...new Set([...(topic.links.draftIds || []),draftId])];
  if(topic.status!=='archived')topic.status='drafted';topic.updatedAt=stamp();return topic;
}
export function markInterrupted(data,id){const topic=getTopic(data,id);if(topic && topic.status==='writing' && !topic.links.draftIds?.length){topic.status='selected';topic.updatedAt=stamp();}return topic;}
export function listTopics(data,{query='',status='active',sort='recent'}={}){
  const term=String(query).trim().toLocaleLowerCase();
  return ensureLibrary(data).topics.filter(topic=>{
    if(status==='active' && topic.status==='archived' || status!=='active' && status!=='all' && topic.status!==status)return false;
    return !term || [topic.title,topic.angle,topic.reader,topic.premise,topic.material,topic.evidenceGaps,topic.source?.title,topic.source?.url].join('\n').toLocaleLowerCase().includes(term);
  }).sort((a,b)=>sort==='oldest'?String(a.createdAt).localeCompare(String(b.createdAt)):String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export function topicToScene(topic){
  if(topic.status==='archived')throw new Error('请先恢复已归档选题。');
  const source=topic.source || {},material=[source.text?`【选题来源快照：${source.title || topic.title}】\n${source.text}`:'',
    topic.material && topic.material!==source.text?`【补充素材与笔记】\n${topic.material}`:'',source.url?`来源链接（仅作记录，尚未读取）：${source.url}`:''].filter(Boolean).join('\n\n');
  if(material.length>15800)throw new Error('来源快照与补充笔记合计过长，请精简补充素材后再进入创作。');
  return {sceneId:'wechat',topicId:topic.id,values:{subject:topic.title,reader:topic.reader,material,
    requirements:[topic.angle?`写作切入角度：${topic.angle}`:'',topic.premise?`作者观点：${topic.premise}`:'',topic.evidenceGaps?`发布前待核实 / 待补充：${topic.evidenceGaps}`:'','只依据提供的资料写作，缺少的事实列为待补充。'].filter(Boolean).join('\n')}};
}
export function exportTopic(topic){
  return `# ${topic.title}\n\n状态：${STATUS[topic.status] || topic.status}\n\n## 写作角度\n${topic.angle || '待补充'}\n\n## 目标读者\n${topic.reader || '待补充'}\n\n## 作者观点\n${topic.premise || '待补充'}\n\n## 素材与笔记\n${topic.material || '待补充'}\n\n## 待核实与待补充\n${topic.evidenceGaps || '尚未填写'}\n\n## 来源快照\n来源：${topic.source?.title || '手动输入'}\n链接：${topic.source?.url || '未填写'}\n捕获时间：${topic.source?.captured_at || ''}\n\n${topic.source?.text || ''}\n\n关联会话：${(topic.links?.sessionIds || []).length}；关联稿件：${(topic.links?.draftIds || []).length}\n`;
}
