// Workspace migrations and document merging are independent of the rendered UI.
export const uid = () => crypto.randomUUID();
export const DEFAULT_SKILL = 'builtin:deep-recreate';
export const cleanName = value => String(value || '未命名').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').trim().replace(/^[._]+/, '') || '未命名';
export const count = value => Array.from(String(value || '').replace(/[\s\u0085\u001c-\u001f]/g, '')).length;
export function manuscriptCount(value,{article=false}={}) {
  const text=String(value || ''),full=count(text);if(article)return {body:full,full};
  const appendix=/^(?:置顶评论|拍摄建议|拍摄备注|拍摄提示|发布说明|发布建议|制作备注|镜头建议|分镜建议|音效建议|修改说明|待核项|来源说明|诊断表|红队自查)(?:\s*[:：].*)?$/;
  let skipping=null;const lines=[];
  for(const line of text.split(/\r?\n/)){
    const match=/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if(match){const level=match[1].length,label=match[2].replace(/^[* _]+|[* _]+$/g,'').replace(/^[^\p{L}\p{N}_]+\s*/u,'');
      if(appendix.test(label)){skipping=level;continue;}if(skipping!==null && level<=skipping)skipping=null;
    }
    if(skipping===null)lines.push(line);
  }
  return {body:count(lines.join('\n')),full};
}
export const countLabel = (value, options) => {
  const {body,full}=manuscriptCount(value,options);
  return `正文 ${body} 字${body!==full?` · 全文 ${full} 字`:''}`;
};
export const makeSession = () => ({id:uid(), title:'新会话', skillId:DEFAULT_SKILL, trackId:'', currentDocumentId:'', messages:[], input:'', images:[], referenceIds:[], includeDraft:true, searchMode:'off', thinking:'auto', summary:'', createdAt:new Date().toISOString()});
export const makeDoc = (title='未命名稿件', text='', folder='二创稿') => ({id:uid(), title:cleanName(title), path:`${folder}/${cleanName(title)}.md`, text, folderId:folder, updatedAt:new Date().toISOString(), version:text ? 1 : 0, versions:text ? [{version:1,text,kind:'import',createdAt:new Date().toISOString()}] : []});
export const makeReference = (title, text) => ({id:uid(), title:cleanName(title), text, path:`引用来源/${cleanName(title)}.md`, readOnly:true, createdAt:new Date().toISOString()});

export function normalizeState(input) {
  const data = structuredClone(input || {});
  data.drafts ||= []; data.folders ||= []; data.skills ||= []; data.references ||= []; data.sessions ||= []; data.ui ||= {};
  if (data.schemaVersion !== 2) {
    for (const draft of data.drafts) {
      for (const reference of draft.references || []) {
        if (!data.references.some(r => r.id === reference.id)) data.references.push({...reference, path:`引用来源/${cleanName(reference.title)}.md`, readOnly:true});
      }
      for (const old of draft.sessions || []) if (!data.sessions.some(s => s.id === old.id)) {
        data.sessions.push({...makeSession(), ...old, currentDocumentId:draft.id, referenceIds:(draft.references || []).filter(r => r.enabled !== false).map(r => r.id)});
      }
      if (draft.quickDraft && !data.ui.quickDraft) data.ui.quickDraft = draft.quickDraft;
    }
    // Preserve custom skills; retired starter assistants are removed below.
    data.skills = data.skills.map(skill => ({...skill, id:skill.id.startsWith('builtin:') ? `user:${uid()}` : skill.id, builtin:false, description:skill.description || '', version:skill.version || '旧版', legacy:['rewrite','polish','review'].includes(skill.id)}));
    data.schemaVersion = 2;
  }
  const retired = new Set(['rewrite','polish','review']);
  data.skills = data.skills.filter(skill => !retired.has(skill.id));
  for (const draft of data.drafts) {
    draft.text ||= ''; draft.versions ||= []; draft.updatedAt ||= new Date().toISOString();
    draft.path ||= `${draft.folderId && data.folders.find(f => f.id === draft.folderId)?.name ? `二创稿/${cleanName(data.folders.find(f => f.id === draft.folderId).name)}` : '二创稿'}/${cleanName(draft.title)}.md`;
    draft.folderId = draft.path.slice(0, draft.path.lastIndexOf('/')) || '二创稿';
  }
  for (const s of data.sessions) {
    s.messages ||= []; s.referenceIds ||= []; s.images ||= []; s.input ||= ''; s.summary ||= '';
    s.skillId = s.skillId && s.skillId!=='builtin:basic-rewrite' && !retired.has(s.skillId) ? s.skillId : DEFAULT_SKILL;
    s.searchMode ||= 'off'; s.thinking ||= 'auto'; s.trackId ||= '';
  }
  if (!data.sessions.length) data.sessions.push(makeSession());
  if (!data.sessions.some(s => s.id === data.ui.activeSessionId)) data.ui.activeSessionId = data.sessions[0].id;
  data.ui.tabs ||= []; data.ui.quickDraft ||= '';
  data.ui.tabs = data.ui.tabs.filter(tab => tab.kind !== 'skill' || !retired.has(tab.id));
  if (!data.ui.tabs.some(tab => tab.key === data.ui.activeTab)) data.ui.activeTab = data.ui.tabs[0]?.key || '';
  return data;
}

export function mergeReply(data, result, sessionId, selectedSkill) {
  const target = data.sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('会话已被删除，未覆盖稿件。请保留本次回复。');
  const changes = [], errors = [...(result.documentErrors || [])];
  const groups = new Map();
  for (const change of result.changes || []) {
    const key = change.draftId || change.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(change);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const current = data.drafts.find(d => d.id === first.draftId || d.path === first.path);
    if (current && (current.text !== first.before || current.path !== first.path)) {
      errors.push({path:first.path,reason:'生成期间稿件已被编辑，本次改写未覆盖你的编辑。'});
      continue;
    }
    const updated = result.drafts?.find(d => d.id === first.draftId || d.path === first.path);
    if (!updated) { errors.push({path:first.path,reason:'未收到稿件快照，请重试。'}); continue; }
    // AI replies carry the document snapshot from request start. Production
    // records may have changed while the request streamed, and only local
    // review/publishing actions may author them. Keep the current record (even
    // its absence), and never accept production metadata on a new AI draft.
    const contentUpdate = structuredClone(updated);
    delete contentUpdate.production;
    if (current) Object.assign(current, contentUpdate); else data.drafts.push(contentUpdate);
    const document = current || data.drafts.at(-1);
    document.folderId = document.path.slice(0,document.path.lastIndexOf('/')) || '二创稿';
    changes.push(...structuredClone(group));
    target.currentDocumentId = document.id;
  }
  const lengthWarnings=structuredClone(result.lengthWarnings || []).filter(warning=>changes.some(change=>change.path===warning.path));
  const message = {id:uid(),role:'assistant',content:result.text || '',rawText:result.rawText || result.text || '',model:result.model,skillName:selectedSkill?.name || 'AI 助手',changes,documentErrors:errors,lengthWarnings,searchResults:result.searchResults || [],searchError:result.searchError || '',createdAt:new Date().toISOString(),...(result.workflow?{workflow:structuredClone(result.workflow)}:{})};
  target.messages.push(message);
  return message;
}

export function saveNewVersion(draft, text=draft.text, kind='manual-version') {
  const versions = draft.versions ||= [];
  const version = Math.max(draft.version || 0, ...versions.map(v => v.version || 0)) + 1;
  draft.text = text; draft.version = version; draft.updatedAt = new Date().toISOString();
  versions.push({version,text,kind,createdAt:draft.updatedAt});
  return version;
}

// Strip only a recognisable auxiliary suffix. Article headings and section prose
// remain part of the manuscript even when preceded by a long introduction.
export function pipelineBody(text, {article=false}={}) {
  text=String(text || '');
  if(article) return {body:text.trim(),stripped:[]};
  const lines=text.replace(/\r\n/g,'\n').split('\n'), heading=/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
  const auxiliary=label=>/^(?:(?:[五七57](?:步|环节))?(?:成交链路|流量结构|流量|结构|文案|写作)?诊断(?:表|记录|结果)?|(?:红队)?自查(?:记录|结果)?|修改说明|本轮修改|交付说明|发布说明|拍摄建议|置顶评论|待核(?:事项|信息|清单))$/.test(label.replace(/^[^\p{L}\p{N}]+/u,'').trim().replace(/[：:]$/,''));
  const headings=[];let fence=null;
  lines.forEach((line,index)=>{
    const marker=/^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length)fence=null;return;}
    if(!fence){const match=heading.exec(line);if(match)headings.push({index,label:match[1]});}
  });
  const suffix=headings.findIndex((entry,index)=>auxiliary(entry.label)&&headings.slice(index).every(item=>auxiliary(item.label)));
  const index=suffix<0?-1:headings[suffix].index;
  if (index<0) return {body:text.trim(),stripped:[]};
  let before=lines.slice(0,index);
  while (before.length && /^(?:\s*|[-*]{3,})$/.test(before.at(-1).trim())) before.pop();
  const body=before.join('\n').trim();
  if (body.length<100 || body.length<text.trim().length*.3) return {body:text.trim(),stripped:[]};
  return {body,stripped:headings.slice(suffix).map(entry=>entry.label)};
}
