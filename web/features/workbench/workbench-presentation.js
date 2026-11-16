// Presentation only: protocol markers here never write or modify documents.
import {count, manuscriptCount} from './workbench-state.js';
const parser = new globalThis.commonmark.Parser();
const renderer = new globalThis.commonmark.HtmlRenderer({safe:true});

export function markdown(text) {
  return renderer.render(parser.parse(String(text || '')));
}

// Fold only recognisable auxiliary sections, never manuscript prose or code.
export function readableReply(text,{streaming=false,key='reply'}={}) {
  text=String(text || '');if(streaming)return markdown(text);
  const lines=text.split('\n'),offsets=[0];for(const line of lines)offsets.push(offsets.at(-1)+line.length+1);
  const nodes=[];for(let node=parser.parse(text).firstChild;node;node=node.next)nodes.push(node);
  const plain=node=>{let result='',event,walk=node.walker();while((event=walk.next()))if(event.entering&&['text','code'].includes(event.node.type))result+=event.node.literal||'';return result;};
  const title=node=>node.type==='heading'?plain(node):node.type==='paragraph'&&node.firstChild?.type==='strong'&&!node.firstChild.next?plain(node):'';
  const auxiliary=value=>/^(?:(?:[五七57](?:步|环节))?(?:成交链路|流量结构|流量|结构|文案|写作)?诊断(?:表|记录|结果)?|(?:红队)?自查(?:记录|结果)?|修改说明|本轮修改|交付说明|待核(?:事项|信息|清单))$/.test(value.replace(/^[^\p{L}\p{N}]+/u,'').trim().replace(/[：:]$/,''));
  let cursor=0,html='';
  for(let i=0;i<nodes.length;i++) {
    const node=nodes[i],label=title(node);if(!label||!auxiliary(label))continue;
    const start=offsets[node.sourcepos[0][0]-1];if(start<cursor)continue;
    let end=text.length;
    for(let j=i+1;j<nodes.length;j++) {
      const next=nodes[j],nextTitle=title(next);
      if(nextTitle&&(auxiliary(nextTitle)||next.type==='heading'&&(next.level||2)<=(node.level||2))){end=offsets[next.sourcepos[0][0]-1];break;}
    }
    html+=markdown(text.slice(cursor,start));
    const bodyStart=offsets[node.sourcepos[1][0]]??text.length;
    const safe=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    html+=`<details class="studio-reply-detail" data-detail-key="${safe(key)}-${start}"><summary><span>${safe(label)}</span><small>展开查看</small></summary><div class="studio-reply-detail-body">${markdown(text.slice(bodyStart,end))}</div></details>`;
    cursor=end;
  }
  return html+markdown(text.slice(cursor));
}

export function searchResults(results=[]) {
  const seen=new Set();
  return results.filter(item => {
    try {
      const url=new URL(item.url);
      if (!['http:','https:'].includes(url.protocol)) return false;
      url.hash='';
      if (seen.has(url.href)) return false;
      seen.add(url.href); return true;
    } catch (_) { return false; }
  });
}

// Parse for display and candidate review only. Applying a document remains the
// responsibility of the validated write path and an explicit user action.
function documentBlocks(raw) {
  if (!/<<<(?:FILE|EDIT)\b|^\s*# FILE\s/m.test(raw)) return [];
  // Ignore examples inside Markdown code blocks, including indented code.
  const lines=[0]; for (let i=0;i<raw.length;i++) if (raw[i]==='\n') lines.push(i+1);
  const fences=[], walker=parser.parse(raw).walker(); let event;
  while ((event=walker.next())) if (event.entering && event.node.type==='code_block') {
    const [start,end]=event.node.sourcepos; fences.push([lines[start[0]-1],lines[end[0]] ?? raw.length]);
  }
  const outsideCode=index => !fences.some(([start,end]) => index>=start && index<end);
  const candidates=[...raw.matchAll(/^[ \t]*<<<(FILE|EDIT) path="([^"\r\n]+)">>>[ \t]*\r?$/gm)].map(m => ({start:m.index,end:m.index+m[0].length,kind:m[1].toLowerCase(),path:m[2],syntax:'native'}));
  for (const m of raw.matchAll(/^[ \t]*# FILE[ \t]+(?:path=)?("[^"\r\n]+"|[^\r\n]+?)[ \t]*\r?$/gm)) candidates.push({start:m.index,end:m.index+m[0].length,kind:'file',path:m[1].replace(/^"|"$/g,''),syntax:'hash'});
  const commands=candidates.filter(c => outsideCode(c.start)).sort((a,b) => a.start-b.start);
  const blocks=[]; let consumed=0, ordinal=0;
  for (const [index,command] of commands.entries()) {
    if (command.start<consumed) continue;
    const endRE=command.syntax==='native'?/^[ \t]*<<<END>>>[ \t]*\r?$/gm:/^[ \t]*# END FILE[ \t]*\r?$/gm;
    endRE.lastIndex=command.end;
    let end; do { end=endRE.exec(raw); } while (end && !outsideCode(end.index));
    const next=commands[index+1]?.start ?? raw.length;
    const complete=Boolean(end && end.index<next), stop=complete?end.index+end[0].length:next;
    blocks.push({...command,complete,stop,operationIndex:ordinal,text:raw.slice(command.end,complete?end.index:stop).replace(/^\r?\n/,'').replace(/\r?\n$/,'')});
    ordinal++; consumed=stop;
  }
  return blocks;
}

export function replyParts(message, streaming=false) {
  const raw=String(message.rawText || message.content || ''), changes=message.changes || [];
  const used=new Set(), parts=[], blocks=documentBlocks(raw);
  if (blocks.length) {
    let consumed=0;
    for (const command of blocks) {
      const {operationIndex:ordinal,complete,stop}=command;
      if (command.start>consumed) parts.push({type:'text',text:raw.slice(consumed,command.start)});
      const error=(message.documentErrors || []).find(e => e.index===ordinal);
      const changeIndex=error?-1:changes.findIndex((change,i) => !used.has(i) && change.path===command.path && change.kind===command.kind && (change.operationIndex===undefined || change.operationIndex===ordinal));
      if (changeIndex>=0) { used.add(changeIndex); parts.push({type:'change',changeIndex}); }
      else if (streaming) {
        const replacement=/^[ \t]*<<<NEW>>>[ \t]*\r?$/m.exec(command.text);
        const text=command.kind==='edit'?(replacement?command.text.slice(replacement.index+replacement[0].length):''):command.text;
        parts.push({type:'pending',path:command.path,kind:command.kind,complete,count:command.kind==='edit'?count(text):manuscriptCount(text).body});
      }
      else parts.push({type:'error',path:command.path,kind:command.kind,complete,operationIndex:ordinal,reason:error?.reason || (message.documentErrors || []).find(e => e.path===command.path)?.reason || (complete?'操作未应用':'输出中断，块不完整')});
      consumed=stop;
    }
    if (consumed<raw.length) parts.push({type:'text',text:raw.slice(consumed)});
  } else parts.push({type:'text',text:message.content || raw});
  // Older sessions may only contain stripped prose and successful operations.
  changes.forEach((change,index) => { if (!used.has(index)) parts.push({type:'change',changeIndex:index}); });
  // Keep surrounding analysis and source notes visible. A model's prose is not
  // proof of a save; this notice records the result without erasing that prose.
  if (!streaming && message.documentErrors?.length) parts.unshift({type:'text',text:saveOutcome(message)});
  else if (!streaming && message.lengthWarnings?.length) parts.unshift({type:'text',text:'草稿已保存，可以直接编辑。字数与要求的差异见下方提示。'});
  return parts;
}

export function saveOutcome(message) {
  const errors=message.documentErrors || [], changes=message.changes || [];
  if (!errors.length) return changes.length?`本轮有 ${changes.length} 项稿件操作已通过校验。`:'本轮没有已保存的稿件操作。';
  return `本轮有 ${errors.length} 项稿件操作未保存；${changes.length?`另有 ${changes.length} 项操作已通过校验。`:'原有稿件保持不变。'}请查看未应用提示；模型回复中的保存说明不代表实际保存结果。`;
}

export function lengthNote(bounds, actual) {
  if (!bounds || !Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || !Number.isFinite(actual) || actual>=bounds.min && actual<=bounds.max) return '';
  return `正文 ${actual} 字，${actual>bounds.max?`比要求多 ${actual-bounds.max}`:`比要求少 ${bounds.min-actual}`} 字（要求 ${bounds.min}–${bounds.max} 字）。草稿已保留，可继续修改。`;
}

export function failedReplyContext(message) {
  return saveOutcome(message)+'\n软件记录的失败原因：\n'+(message.documentErrors || []).map(error=>`${error.path || ''}：${error.reason || error.message || '未应用'}`).join('\n')+
    '\n以下是模型候选回复，其中失败的操作未保存，仅供修改参考；实际已保存内容以本轮文档清单为准：\n'+(message.rawText || message.content || '');
}

export function recoverableFile(message, operationIndex) {
  if (!Number.isInteger(operationIndex) || operationIndex<0) return null;
  const part=replyParts(message).find(item=>item.type==='error' && item.operationIndex===operationIndex);
  if (!part?.complete || part.kind!=='file') return null;
  const block=documentBlocks(String(message.rawText || message.content || '')).find(item=>item.operationIndex===operationIndex);
  if (!block?.complete || !block.text.trim()) return null;
  // A candidate is plain FILE content, never an EDIT fragment or nested command.
  if (/^[ \t]*<<<(?:FILE|EDIT|OLD|NEW|END)\b|^[ \t]*# (?:END )?FILE\b/m.test(block.text)) return null;
  const path=block.path, title=path.replace(/\\/g,'/').split('/').at(-1).replace(/\.(?:md|markdown|txt)$/i,'');
  return {title,path,text:block.text,operationIndex};
}
