const $=s=>document.querySelector(s);
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session='', mounted=false, moduleConfig, currentLicense, stage='login';
const nativeFetch=window.fetch.bind(window);
let toastTimer;
export function toast(message,type=''){$('#toast').textContent=message;$('#toast').className=type;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}

export async function bridgeReady(){
 if(typeof window.pywebview?.api?.session === 'function') {
  session = await window.pywebview.api.session();
 } else {
  session = 'community-session-' + Date.now();
 }
 window.fetch=(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href), headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));
  if(url.origin===location.origin)headers.set('X-Workbench-Session',session);
  return nativeFetch(input,{...options,headers});
 };
}

export async function api(url,options={}){
 const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});
 let value;try{value=await response.json();}catch{throw new Error(`请求失败 (${response.status})`);}
 if(!response.ok){const detail=value.detail; if(detail?.code==='LICENSE_REQUIRED') lock(detail.message);const error=new Error(typeof detail==='string'?detail:Array.isArray(detail)?detail.map(item=>String(item.msg||'输入内容无效').replace(/^Value error, /,'')).join('；'):detail?.message||`请求失败 (${response.status})`);error.detail=detail;throw error;}
 return value;
}

export async function copy(text){
  try {
    if(navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else if(window.pywebview?.api?.copy_text) {
      await window.pywebview.api.copy_text(text);
    } else {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('已复制');
  } catch(e) {
    toast('复制失败: ' + e.message, 'error');
  }
}

export async function download(name,text,type='text/plain'){
 const href=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');link.href=href;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(href),3000);toast('已下载');
}

window.previewWorkbenchSource=async spec=>{if(!mounted)await enter();return moduleConfig?.previewSource?.(spec);};
window.showSourcePreviewModal=spec=>window.previewWorkbenchSource(spec);
const studioPages={home:'工作总览',radar:'灵感雷达',library:'素材与稿件',topics:'选题计划',workbench:'创作工坊',delivery:'成品与发布',insights:'数据复盘',video_studio:'视频生成平台',wanfeng:'晚风拾响',creatorhub:'采集与矩阵',image_workbench:'生图工坊'};
const flowPages=new Set(['home','library','topics','delivery','insights']);
try{window.currentStudioTab=localStorage.getItem('studio-current-page') || 'home';}catch{window.currentStudioTab='home';}
if(!Object.hasOwn(studioPages,window.currentStudioTab))window.currentStudioTab='home';
window.switchStudioTab=function(tabName){
 if(!Object.hasOwn(studioPages,tabName))return;
 window.currentStudioTab=tabName;
 try{localStorage.setItem('studio-current-page',tabName);}catch{}
 document.querySelectorAll('.studio-tab').forEach(t=>{const active=t.dataset.tab===tabName;t.classList.toggle('active',active);if(active)t.setAttribute('aria-current','page');else t.removeAttribute('aria-current');});
 document.querySelectorAll('.studio-view').forEach(v=>v.hidden=true);
 const target=document.getElementById(flowPages.has(tabName)?'studioFlowView':tabName+'View');
 if(target)target.hidden=false;
 $('#studioPageTitle').textContent=studioPages[tabName];
 if(tabName==='radar')window.initRadarView?.();
 if(tabName==='video_studio')window.initVideoStudioView?.();
 if(tabName==='image_workbench'){
  api('/api/image-workbench/status').then(res=>{
   const iframe=$('#imageWorkbenchStudioIframe');
   if(iframe && (!iframe.src || iframe.src==='about:blank' || !iframe.dataset.loaded)){
    iframe.src='http://127.0.0.1:8092/';
    iframe.dataset.loaded='true';
   }
  }).catch(()=>{});
 }
 if(mounted && flowPages.has(tabName))moduleConfig.showWorkspacePage?.(tabName,{query:$('#studioSearch').value});
 if(window.innerWidth<=700)document.body.classList.add('studio-nav-collapsed');
 $('#studioNavToggle').setAttribute('aria-expanded',String(!document.body.classList.contains('studio-nav-collapsed')));
};

function showStage(next){
 stage=next;document.body.dataset.stage=next;$('#studioSidebar').hidden=next!=='workbench';
 $('#onboarding').hidden=next==='workbench';$('.app-header').hidden=next!=='workbench';
 $('#activation').hidden=next!=='login';$('#setup').hidden=next!=='setup';
 if (next === 'workbench') {
   window.switchStudioTab(window.currentStudioTab || 'workbench');
 } else {
   document.querySelectorAll('.studio-view').forEach(v => v.hidden = true);
 }
 document.querySelectorAll('[data-step]').forEach((item,index)=>{const active=item.dataset.step===next;item.toggleAttribute('aria-current',active);if(active)item.setAttribute('aria-current','step');item.classList.toggle('complete',index<['login','setup','workbench'].indexOf(next));});
 $('#backToWorkbench').hidden=!(next==='login'&&currentLicense?.valid);
}

function lock(reason){
 if(!$('#activation'))return;
 showStage('login');$('#licenseReason').textContent=reason;$('#settingsButton').disabled=true;$('#apiKey').value='';$('#baseUrl').value='';$('#modelName').value='';
 document.querySelectorAll('dialog[open]').forEach(d=>d.close());
}

async function displayStatus(){
 currentLicense=await api('/api/license/status');$('#machineCode').value=currentLicense.machine_code;$('#licenseReason').textContent=currentLicense.valid?'本机授权有效，可以进入工作台。':currentLicense.reason;
 if(!currentLicense.valid){lock(currentLicense.reason);return;}
 const model=await api('/api/writing-workbench/model');
 if(!model.api_key_configured||!model.verified){await openSettings(true,model);return;}
 await enter();
}

async function enter(){
 showStage('workbench');$('#settingsButton').disabled=false;
 if(!mounted){
  const script=document.createElement('script');script.src='/web/features/workbench/workbench.js?v=1.2.36-20261115';
  await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(new Error('工作台脚本加载失败'));document.head.append(script);});
  const css=document.createElement('link');css.rel='stylesheet';css.href=moduleConfig.styleUrl;document.head.append(css);
  $('#workbenchView').innerHTML=await (await fetch(moduleConfig.templateUrl)).text();
  await moduleConfig.mount($('#workbenchView'),{esc,api,showToast:toast,showConfirm:confirmAction,openWorkbenchSettings:openSettings,download,copy,previewSource:spec=>window.previewWorkbenchSource(spec)});mounted=true;
 }else moduleConfig.activate();
 window.switchStudioTab(window.currentStudioTab);
 const intakeURL=new URL(location.href);if(intakeURL.searchParams.has('source_url')){window.previewWorkbenchSource({url:intakeURL.searchParams.get('source_url'),title:intakeURL.searchParams.get('source_title')||'原文'});intakeURL.searchParams.delete('source_url');intakeURL.searchParams.delete('source_title');history.replaceState(null,'',intakeURL.pathname+intakeURL.search+intakeURL.hash);}
}

function confirmAction({title,message,okText='确定'}){return new Promise(resolve=>{$('#confirmTitle').textContent=title;$('#confirmMessage').textContent=message;$('#confirmYes').textContent=okText;const dialog=$('#confirmDialog');$('#confirmYes').onclick=()=>{dialog.close();resolve(true);};$('#confirmNo').onclick=()=>dialog.close();dialog.oncancel=()=>resolve(false);dialog.onclose=()=>resolve(false);dialog.showModal();});}

async function openSettings(guided=false,value){
 value=value||await api('/api/writing-workbench/model');
 const form=$('#settingsForm');
 if(guided){
  if($('#settingsDialog').open)$('#settingsDialog').close();
  $('#setupFormHost').append(form);showStage('setup');
 }else{$('#settingsDialog').append(form);}
 $('#settingsHeading').hidden=guided;$('#settingsCancel').hidden=guided;$('#testSave').textContent=guided?'测试并进入工作台':'测试并保存';
 $('#apiKey').value='';$('#apiKey').type='password';$('#toggleKey').textContent='显示';$('#apiKey').placeholder=value.api_key_masked||'输入你的 API Key';
  $('#baseUrl').value=value.base_url||'';
  $('#modelName').value=value.model||'';
 $('#keyStatus').textContent=value.api_key_configured?'密钥已保存，留空可使用原密钥重新测试。':'密钥仅保存在这台电脑，请填写接口地址与密钥完成首次配置。';
 $('#modelTestStatus').textContent='';$('#modelTestStatus').classList.remove('is-error');
 if(!guided)$('#settingsDialog').showModal();
 $('#apiKey').focus();
}

// ---------------- Radar View Logic ----------------
let radarHotData = [];
let radarHotCurrentPlatform = 'all';
let radarCurrentSub = 'hot';
let aihotData = { hot: [], daily: { title: '', items: [] } };
let aihotCurrentMode = 'hot'; // 'hot' or 'daily'
let wechat10wData = { items: [], categories: [] };
let wechat10wCurrentCat = '全部';
let radarInitialized = false;

window.initVideoStudioView = async function() {
  const container = document.getElementById('video_studioView');
  if (!container) return;
  if (!container.innerHTML.trim()) {
    try {
      const res = await fetch('/web/features/video_studio/video_studio.html');
      container.innerHTML = await res.text();
      const { initVideoStudio } = await import('/web/features/video_studio/video_studio.js');
      await initVideoStudio();
    } catch(e) {
      console.error('Failed to init video_studio view:', e);
    }
  }
};

window.initRadarView = async function() {
  if (radarInitialized) return;
  radarInitialized = true;

  // Subtab switching
  document.querySelectorAll('.radar-subtab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.radar-subtab').forEach(b => {
        const isCurrent = b === btn;
        b.classList.toggle('active', isCurrent);
        b.style.background = isCurrent ? '#fff' : 'transparent';
        b.style.color = isCurrent ? '#0f172a' : '#64748b';
        b.style.boxShadow = isCurrent ? '0 1px 2px rgba(0,0,0,0.05)' : 'none';
      });
      const sub = btn.dataset.radarSub;
      radarCurrentSub = sub;
      $('#radarSubHot').hidden = sub !== 'hot';
      $('#radarSubAihot').hidden = sub !== 'aihot';
      $('#radarSubWechat10w').hidden = sub !== 'wechat10w';
      $('#radarSubWechat').hidden = sub !== 'wechat';
      $('#radarSubCreatorHub').hidden = sub !== 'creatorhub';

      if (sub === 'aihot' && !$('#radarAihotCards').children.length) {
        loadAihotRadar();
      } else if (sub === 'wechat10w' && !$('#radarWechat10wCards').children.length) {
        loadWechat10wRadar();
      } else if (sub === 'wechat' && !$('#radarWechatCards').children.length) {
        searchWechatRadar();
      } else if (sub === 'creatorhub' && !$('#radarCreatorHubCards').children.length) {
        loadCreatorHubRadar();
      }
    };
  });

  // AIHOT mode switch
  document.querySelectorAll('.aihot-mode-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.aihot-mode-btn').forEach(b => {
        const isCurrent = b === btn;
        b.classList.toggle('active', isCurrent);
        b.style.background = isCurrent ? '#fff' : 'transparent';
        b.style.color = isCurrent ? '#0f172a' : '#64748b';
      });
      aihotCurrentMode = btn.dataset.mode;
      renderAihotCards($('#radarMasterSearch').value.trim().toLowerCase());
    };
  });

  // Search filter
  $('#radarMasterSearch').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    if (radarCurrentSub === 'hot') renderRadarHot(q);
    else if (radarCurrentSub === 'aihot') renderAihotCards(q);
    else if (radarCurrentSub === 'wechat10w') renderWechat10wCards(q);
  };

  $('#radarRefreshBtn').onclick = () => {
    if (radarCurrentSub === 'hot') loadRadarHot(true);
    else if (radarCurrentSub === 'aihot') loadAihotRadar(true);
    else if (radarCurrentSub === 'wechat10w') loadWechat10wRadar(true);
    else if (radarCurrentSub === 'wechat') searchWechatRadar(true);
    else if (radarCurrentSub === 'creatorhub') loadCreatorHubRadar();
  };

  // WeChat search trigger
  $('#wechatSearchBtn').onclick = () => searchWechatRadar(true);
  $('#wechatSearchKeyword').onkeydown = e => { if (e.key === 'Enter') searchWechatRadar(true); };

  await loadRadarHot();
};

async function loadRadarHot(force = false) {
  try {
    const data = await api('/api/materials');
    radarHotData = data.items || [];
    renderRadarHotTabs();
    renderRadarHot();
  } catch (e) {
    toast('热搜榜加载失败: ' + e.message, 'error');
  }
}

function renderRadarHotTabs() {
  const container = $('#radarHotPills');
  if (!container) return;
  const platforms = [
    { id: 'all', name: '全网综合' },
    { id: '今日头条', name: '今日头条' },
    { id: '百度', name: '百度热搜' },
    { id: '抖音', name: '抖音热点' },
    { id: '微博', name: '微博热搜' },
    { id: '知乎', name: '知乎热榜' },
    { id: 'AI', name: 'AI 前沿' }
  ];
  container.innerHTML = platforms.map(p => `
    <button type="button" class="radar-hot-pill ${p.id === radarHotCurrentPlatform ? 'active' : ''}" data-plat="${p.id}"
      style="padding:5px 12px;border:1px solid ${p.id === radarHotCurrentPlatform ? '#059669' : '#e2e8f0'};border-radius:20px;font-size:12px;background:${p.id === radarHotCurrentPlatform ? '#ecfdf5' : '#fff'};color:${p.id === radarHotCurrentPlatform ? '#047857' : '#475569'};cursor:pointer;white-space:nowrap;font-weight:${p.id === radarHotCurrentPlatform ? '600' : 'normal'}">
      ${p.name}
    </button>
  `).join('');

  container.querySelectorAll('.radar-hot-pill').forEach(btn => {
    btn.onclick = () => {
      radarHotCurrentPlatform = btn.dataset.plat;
      renderRadarHotTabs();
      renderRadarHot($('#radarMasterSearch').value.trim().toLowerCase());
    };
  });
}

function renderRadarHot(filter = '') {
  const container = $('#radarHotCards');
  if (!container) return;
  let items = radarHotData;
  if (radarHotCurrentPlatform !== 'all') {
    if (radarHotCurrentPlatform === 'AI') {
      items = items.filter(it => (it.platform || '').startsWith('AI'));
    } else {
      items = items.filter(it => it.platform === radarHotCurrentPlatform);
    }
  }
  if (filter) {
    items = items.filter(it => (it.title || '').toLowerCase().includes(filter) || (it.hot || '').toLowerCase().includes(filter));
  }
  if (!items.length) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#94a3b8">暂无相关热搜，点击刷新试试</div>`;
    return;
  }
  container.innerHTML = items.slice(0, 60).map((it, idx) => `
    <div class="radar-card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:#f1f5f9;color:#475569">${esc(it.platform_name || it.platform)}</span>
        <span style="font-size:11px;color:#ef4444;font-weight:600">🔥 ${esc(it.hot || '热门')}</span>
      </div>
      <a href="${esc(it.url || '#')}" target="_blank" style="font-size:14px;font-weight:600;color:#0f172a;text-decoration:none;line-height:1.4">${esc(it.title)}</a>
      <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px dashed #f1f5f9;gap:6px">
        <span style="font-size:11px;color:#94a3b8">#${idx + 1}</span>
        <div style="display:flex;gap:6px">
          <button type="button" class="radar-btn-send" data-send-hot="${idx}" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:4px 8px;font-size:11px">👀 原文</button>
          <button type="button" class="radar-btn-send" data-draft-hot="${idx}" style="background:#059669;color:#fff;padding:4px 10px;font-size:11px">🚀 一键二创</button>
        </div>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-send-hot]').forEach(btn=>{btn.onclick=()=>{const it=items[Number(btn.dataset.sendHot)];if(it)window.previewWorkbenchSource({title:it.title,url:it.url||'',platform:it.platform_name||it.platform});};});
  container.querySelectorAll('[data-draft-hot]').forEach(btn => {
    btn.onclick = async () => {
      const it = items[Number(btn.dataset.draftHot)];
      if (!it) return;
      btn.disabled = true;
      btn.textContent = '生成中...';
      try {
        const impRes = await api('/api/materials/create-draft', {
          method: 'POST',
          body: JSON.stringify({ title: it.title, platform: it.platform_name || it.platform, url: it.url || '' })
        });
        toast(`✅ 已生成二创草稿《${it.title}》！`);
        window.WorkbenchModules?.loadImportResult(impRes);
      } catch (err) {
        toast('创建失败: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = '🚀 一键二创';
      }
    };
  });
}

async function searchWechatRadar(isExplicitSearch = false) {
  const container = $('#radarWechatCards');
  const kw = $('#wechatSearchKeyword').value.trim() || '晚风 养老 心态';
  if (!isExplicitSearch) {
    try {
      const existing = await api('/api/wechat/articles');
      if (existing.articles && existing.articles.length) {
        renderWechatCards(existing.articles);
        return;
      }
    } catch(e) {}
  }
  container.innerHTML = `<div style="text-align:center;padding:30px;color:#64748b">正在微信搜一搜检索【${esc(kw)}】文章（阅读数据未获取）...</div>`;
  try {
    const res = await api('/api/wechat/search', { method: 'POST', body: JSON.stringify({ keyword: kw, max_per_topic: 5 }) });
    const items = res.articles || res.results || [];
    renderWechatCards(items);
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;padding:30px;color:#ef4444">搜索失败: ${esc(e.message)}（请确保晚风拾响服务正常）</div>`;
  }
}

function renderWechatCards(items) {
  const container = $('#radarWechatCards');
  if (!items || !items.length) {
    container.innerHTML = `<div style="text-align:center;padding:30px;color:#94a3b8">未检索到相关文章，请更换关键词点击搜索</div>`;
    return;
  }
  container.innerHTML = items.map((it, idx) => `
    <div class="radar-card" style="flex-direction:row;align-items:center;justify-content:space-between;gap:16px">
      <div style="flex:1">
        <div style="font-size:15px;font-weight:600;color:#0f172a;margin-bottom:4px">
          <a href="${esc(it.url || '#')}" target="_blank" style="color:inherit;text-decoration:none">${esc(it.title)}</a>
        </div>
        <div style="font-size:12px;color:#64748b;display:flex;gap:12px;align-items:center">
          <span>来源公众号: <strong style="color:#0f172a">${esc(it.account_name || '未获取')}</strong></span>
          <span>阅读: <strong style="color:#dc2626">${esc(it.read_count ?? '未获取')}</strong></span>
          <span>点赞: <strong>${esc(it.like_count ?? '未获取')}</strong></span>
          <span>时间: ${esc(it.pub_time || '未获取')}</span>
        </div>
      </div>
      <button type="button" class="radar-btn-send" data-send-wechat="${idx}" style="white-space:nowrap;padding:8px 14px">获取原文 →</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-send-wechat]').forEach(btn=>{btn.onclick=()=>{const it=items[Number(btn.dataset.sendWechat)];if(it)window.previewWorkbenchSource({title:it.title,url:it.url||'',summary:it.summary||'',platform:'微信文章'});};});
}

async function loadCreatorHubRadar() {
  const container = $('#radarCreatorHubCards');
  container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#64748b">正在读取 CreatorHub 最新采集的爆款视频口播...</div>`;
  try {
    const data = await api('/api/creatorhub/items');
    const items = data.items || [];
    if (!items.length) {
      container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#94a3b8">CreatorHub 爆款库为空，请先在【采集与矩阵】中创建采集任务</div>`;
      return;
    }
    container.innerHTML = items.map((it, idx) => `
      <div class="radar-card">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:#fee2e2;color:#b91c1c">${esc(it.platform)}</span>
          <span style="font-size:11px;color:#64748b">点赞 ${esc(it.likes || 0)} · 评论 ${esc(it.comments || 0)}</span>
        </div>
        <div style="font-size:13px;font-weight:600;color:#0f172a;line-height:1.4">${esc(it.title || '无标题作品')}</div>
        <div style="font-size:11px;color:#64748b">创作者: ${esc(it.author || '未知')} · 关键词: ${esc(it.keyword || '爆款')}</div>
        <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px dashed #f1f5f9">
          <span style="font-size:11px;color:${it.has_transcript ? '#059669' : '#d97706'}">${it.has_transcript ? '✓ 已转写台词' : '⚡ 自动提取文案'}</span>
          <button type="button" class="radar-btn-send" data-send-ch="${idx}">🚀 提取并送入二创</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-send-ch]').forEach(btn => {
      btn.onclick = async () => {
        const it = items[parseInt(btn.dataset.sendCh, 10)];
        if (!it) return;
        btn.disabled = true;
        btn.textContent = '提取中...';
        try {
          const res = await api('/api/creatorhub/import', {
            method: 'POST',
            body: JSON.stringify({ content_id: it.id, job_id: it.job_id })
          });
          toast(`✅ 已送入工坊《${it.title || ''}》！`);
          window.WorkbenchModules?.loadImportResult(res);
        } catch (err) {
          toast('导入失败: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = '🚀 提取并送入二创';
        }
      };
    });
  } catch (e) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#ef4444">读取失败: ${esc(e.message)}</div>`;
  }
}

// ---------------- AIHOT Radar Logic ----------------
async function loadAihotRadar(force = false) {
  const container = $('#radarAihotCards');
  if (!container) return;
  container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:36px;color:#64748b">正在通过卡兹克 AIHOT 引擎同步最新前沿热点与日报...</div>`;
  try {
    const res = await api('/api/radar/aihot' + (force ? '?refresh=true' : ''));
    aihotData = res;
    if (res.daily && res.daily.title) {
      const tip = $('#aihotStatusTip');
      if (tip) tip.textContent = `${res.daily.title} · 同步时间 ${res.updated_at || '刚刚'}`;
    }
    renderAihotCards($('#radarMasterSearch').value.trim().toLowerCase());
  } catch (e) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#ef4444">AIHOT 加载失败: ${esc(e.message)}</div>`;
  }
}

function renderAihotCards(filter = '') {
  const container = $('#radarAihotCards');
  if (!container) return;

  if (aihotCurrentMode === 'hot') {
    let items = aihotData.hot || [];
    if (filter) items = items.filter(it => (it.title || '').toLowerCase().includes(filter) || (it.sources || '').toLowerCase().includes(filter));
    if (!items.length) {
      container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#94a3b8">暂无匹配的 Top 10 热点</div>`;
      return;
    }
    const rankColors = ['#f59e0b', '#94a3b8', '#b45309'];
    container.innerHTML = items.map((it, idx) => {
      const color = idx < 3 ? rankColors[idx] : '#64748b';
      return `
        <div class="radar-card" style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:12px;font-weight:700;color:${color};background:#f8fafc;padding:3px 8px;border-radius:6px;border:1px solid #e2e8f0">Top ${it.rank || (idx + 1)}</span>
            <span style="font-size:11px;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:12px;font-weight:600">多信源聚合</span>
          </div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;line-height:1.4">
            <a href="${esc(it.url || '#')}" target="_blank" style="color:inherit;text-decoration:none">${esc(it.title)}</a>
          </div>
          <p style="font-size:12px;color:#64748b;line-height:1.5;margin:0;background:#f8fafc;padding:8px 10px;border-radius:6px">
            <strong>信源:</strong> ${esc(it.sources || '多方媒体讨论')}
          </p>
          <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px dashed #f1f5f9;gap:8px">
            <a href="${esc(it.url || '#')}" target="_blank" style="font-size:12px;color:#3b82f6;text-decoration:none;font-weight:500">信源出处 ↗</a>
            <button type="button" class="radar-btn-send" data-send-aihot="${idx}" style="background:#0f172a;color:#fff;border-radius:6px;padding:6px 14px;font-weight:600">🚀 引入工坊写作</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-send-aihot]').forEach(btn => {
      btn.onclick = async () => {
        const it = items[Number(btn.dataset.sendAihot)];
        if (!it) return;
        btn.disabled = true;
        btn.textContent = '导入中...';
        try {
          const res = await api('/api/radar/aihot/import', {
            method: 'POST',
            body: JSON.stringify(it)
          });
          toast(`✅ 已将热点《${it.title}》引入工坊并生成素材稿！`);
          window.WorkbenchModules?.loadImportResult(res);
        } catch (e) {
          toast('引入失败: ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = '🚀 引入工坊写作';
        }
      };
    });
  } else {
    // Daily mode
    let items = (aihotData.daily && aihotData.daily.items) || [];
    if (filter) items = items.filter(it => (it.title || '').toLowerCase().includes(filter) || (it.summary || '').toLowerCase().includes(filter));
    if (!items.length) {
      container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#94a3b8">暂无今日精选早报动态</div>`;
      return;
    }
    container.innerHTML = items.map((it, idx) => `
      <div class="radar-card" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:#e0f2fe;color:#0369a1">${esc(it.category || '最新动态')}</span>
          <span style="font-size:11px;color:#64748b">${esc(it.source || '精选信源')}</span>
        </div>
        <div style="font-size:14px;font-weight:600;color:#0f172a;line-height:1.4">
          <a href="${esc(it.url || '#')}" target="_blank" style="color:inherit;text-decoration:none">${esc(it.title)}</a>
        </div>
        <p style="font-size:12px;color:#475569;line-height:1.5;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary || '')}</p>
        <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px dashed #f1f5f9">
          <a href="${esc(it.url || '#')}" target="_blank" style="font-size:12px;color:#3b82f6;text-decoration:none;font-weight:500">原文 ↗</a>
          <button type="button" class="radar-btn-send" data-send-aihot-daily="${idx}" style="background:#0f172a;color:#fff;border-radius:6px;padding:6px 14px;font-weight:600">🚀 引入工坊写作</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-send-aihot-daily]').forEach(btn => {
      btn.onclick = async () => {
        const it = items[Number(btn.dataset.sendAihotDaily)];
        if (!it) return;
        btn.disabled = true;
        btn.textContent = '导入中...';
        try {
          const res = await api('/api/radar/aihot/import', {
            method: 'POST',
            body: JSON.stringify(it)
          });
          toast(`✅ 已引入早报动态《${it.title}》！`);
          window.WorkbenchModules?.loadImportResult(res);
        } catch (e) {
          toast('引入失败: ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = '🚀 引入工坊写作';
        }
      };
    });
  }
}

// ---------------- WeChat 10w+ Radar Logic ----------------
async function loadWechat10wRadar(force = false) {
  const container = $('#radarWechat10wCards');
  if (!container) return;
  container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:36px;color:#64748b">正在加载 10w+ 爆文选题池数据...</div>`;
  try {
    const res = await api('/api/radar/wechat10w');
    wechat10wData = res;
    renderWechat10wCategories();
    renderWechat10wCards($('#radarMasterSearch').value.trim().toLowerCase());
  } catch (e) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#ef4444">10w+ 爆文加载失败: ${esc(e.message)}</div>`;
  }
}

function renderWechat10wCategories() {
  const container = $('#radarWechat10wCategories');
  if (!container) return;
  const cats = wechat10wData.categories || ['全部'];
  container.innerHTML = cats.map(c => `
    <button type="button" class="radar-10w-cat ${c === wechat10wCurrentCat ? 'active' : ''}" data-cat="${esc(c)}"
      style="padding:4px 12px;border:1px solid ${c === wechat10wCurrentCat ? '#059669' : '#e2e8f0'};border-radius:16px;font-size:12px;background:${c === wechat10wCurrentCat ? '#ecfdf5' : '#fff'};color:${c === wechat10wCurrentCat ? '#047857' : '#475569'};cursor:pointer;white-space:nowrap;font-weight:${c === wechat10wCurrentCat ? '600' : 'normal'}">
      ${esc(c)}
    </button>
  `).join('');

  container.querySelectorAll('.radar-10w-cat').forEach(btn => {
    btn.onclick = () => {
      wechat10wCurrentCat = btn.dataset.cat;
      renderWechat10wCategories();
      renderWechat10wCards($('#radarMasterSearch').value.trim().toLowerCase());
    };
  });
}

function renderWechat10wCards(filter = '') {
  const container = $('#radarWechat10wCards');
  if (!container) return;
  let items = wechat10wData.items || [];
  if (wechat10wCurrentCat !== '全部') {
    items = items.filter(it => it.category === wechat10wCurrentCat);
  }
  if (filter) {
    items = items.filter(it => (it.title || '').toLowerCase().includes(filter) || (it.account_name || '').toLowerCase().includes(filter) || (it.summary || '').toLowerCase().includes(filter));
  }
  if (!items.length) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#94a3b8">未找到匹配的 10w+ 爆款文章</div>`;
    return;
  }

  container.innerHTML = items.map((it, idx) => `
    <div class="radar-card" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          ${it.avatar ? `<img src="${esc(it.avatar)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover" onerror="this.style.display='none'"/>` : ''}
          <span style="font-size:12px;font-weight:600;color:#0f172a">${esc(it.account_name || '公众号')}</span>
        </div>
        <span style="font-size:11px;color:#dc2626;background:#fef2f2;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #fecaca">🔥 ${esc(it.clicks || '10w+')}</span>
      </div>
      <div style="font-size:14px;font-weight:700;color:#0f172a;line-height:1.4">
        <a href="${esc(it.url || '#')}" target="_blank" style="color:inherit;text-decoration:none">${esc(it.title)}</a>
      </div>
      <p style="font-size:12px;color:#64748b;line-height:1.5;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary || it.content || '暂无摘要内容')}</p>
      <div style="font-size:11px;color:#94a3b8;display:flex;gap:10px">
        <span>👍 点赞 ${esc(it.likes || '0')}</span>
        <span>💬 留言 ${esc(it.comments || '0')}</span>
        <span>🔄 分享 ${esc(it.shares || '0')}</span>
      </div>
      <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px dashed #f1f5f9">
        <a href="${esc(it.url || '#')}" target="_blank" style="font-size:12px;color:#3b82f6;text-decoration:none;font-weight:500">原文 ↗</a>
        <button type="button" class="radar-btn-send" data-send-wechat10w="${idx}" style="background:#059669;color:#fff;border-radius:6px;padding:6px 14px;font-weight:600">🚀 送入工坊二创</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-send-wechat10w]').forEach(btn => {
    btn.onclick = async () => {
      const it = items[Number(btn.dataset.sendWechat10w)];
      if (!it) return;
      btn.disabled = true;
      btn.textContent = '导入中...';
      try {
        const res = await api('/api/radar/wechat10w/import', {
          method: 'POST',
          body: JSON.stringify(it)
        });
        toast(`✅ 已送入工坊《${it.title}》！`);
        window.WorkbenchModules?.loadImportResult(res);
      } catch (e) {
        toast('导入失败: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '🚀 送入工坊二创';
      }
    };
  });
}

// ---------------- Skills Catalog Dialog Logic ----------------
let allSkillsList = [];

function initSkillsCatalog() {
  const btn = $('#skillsCatalogBtn');
  const dialog = $('#skillsCatalogDialog');
  if (!btn || !dialog) return;

  btn.onclick = async () => {
    dialog.showModal();
    if (!allSkillsList.length) {
      $('#skillsCatalogList').innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#64748b">正在加载 87+ 创作者技能库...</div>`;
      try {
        const cat = await api('/api/writing-workbench/catalog');
        allSkillsList = cat.skills || [];
        renderSkillsCatalog();
      } catch (e) {
        $('#skillsCatalogList').innerHTML = `<div style="grid-column:1/-1;color:red;text-align:center">加载失败: ${esc(e.message)}</div>`;
      }
    } else {
      renderSkillsCatalog();
    }
  };

  $('#skillsSearchInput').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    renderSkillsCatalog(q);
  };
}

function renderSkillsCatalog(filter = '') {
  const container = $('#skillsCatalogList');
  if (!container) return;
  let items = allSkillsList;
  if (filter) {
    items = items.filter(s => (s.name || '').toLowerCase().includes(filter) || (s.description || '').toLowerCase().includes(filter));
  }
  container.innerHTML = items.map(s => `
    <div class="skill-card" data-skill-id="${esc(s.id)}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:13px;color:#0f172a">${esc(s.name)}</strong>
        <span style="font-size:10px;background:#ecfdf5;color:#059669;padding:1px 6px;border-radius:4px;font-weight:600">${s.id.startsWith('gemini:') ? '专业Skill' : '内置'}</span>
      </div>
      <p style="font-size:11px;color:#64748b;margin:0;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(s.description || '创作者专属 AI 辅助技能')}</p>
    </div>
  `).join('');

  container.querySelectorAll('.skill-card').forEach(card => {
    card.onclick = () => {
      const skillId = card.dataset.skillId;
      const targetSkill = allSkillsList.find(s => s.id === skillId);
      if (targetSkill && window.selectWorkbenchSkill) {
        window.selectWorkbenchSkill(targetSkill);
      }
      $('#skillsCatalogDialog').close();
      window.switchStudioTab('workbench');
      toast(`✦ 已切换创作者助手为【${targetSkill?.name || skillId}】！`);
    };
  });
}

// ---------------- Main Initialization ----------------
async function start(){
 await bridgeReady();
 window.WorkbenchModules={
  register(_name,config){moduleConfig=config;},
  refresh(){moduleConfig?.refresh();},
  prepareReload:()=>moduleConfig?.prepareReload?.(),
  async loadImportResult(result){if(!mounted)await enter();window.switchStudioTab('workbench');return moduleConfig?.loadImportResult?.(result);},
  async openDraft(id){if(!mounted)await enter();window.switchStudioTab('workbench');return moduleConfig?.openDraft?.(id);},
  async previewSource(spec){if(!mounted)await enter();return moduleConfig?.previewSource?.(spec);},
  async startCreation(){if(!mounted)await enter();return moduleConfig?.startCreation?.();},
  showWorkspacePage(page,options){return moduleConfig?.showWorkspacePage?.(page,options);}
 };
 
 // Studio Tab switching
 document.querySelectorAll('[data-tab]').forEach(btn => {
   btn.onclick = () => window.switchStudioTab(btn.dataset.tab);btn.title=btn.textContent.trim();btn.setAttribute('aria-label',btn.textContent.trim());
 });

 $('#studioNavToggle').onclick=()=>{document.body.classList.toggle('studio-nav-collapsed');const open=!document.body.classList.contains('studio-nav-collapsed');$('#studioNavToggle').setAttribute('aria-expanded',String(open));$('#studioNavToggle').setAttribute('aria-label',open?'收起导航':'展开导航');};
 $('#studioNew').onclick=()=>{window.switchStudioTab('workbench');moduleConfig?.startCreation?.();};
 $('#studioSearch').addEventListener('input',()=>{if(mounted)window.switchStudioTab('library');});
 document.addEventListener('keydown',event=>{if((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='k'){event.preventDefault();$('#studioSearch').focus();$('#studioSearch').select();}});

 // Cross-window event listener (from 晚风拾响 or CreatorHub iframes)
 window.addEventListener('message', async (e) => {
   if(e.data?.type==='WORKBENCH_SOURCE_PREVIEW' && ['http://127.0.0.1:8899','http://localhost:8899'].includes(e.origin)){window.previewWorkbenchSource(e.data.source||{});return;}
   if (e.data?.type === 'WANFENG_IMPORT_SUCCESS' || e.data?.type === 'CREATORHUB_IMPORT_SUCCESS') {
     toast(`🌿 已将《${e.data.title || '选定作品'}》无缝送入创作工坊！`);
     window.switchStudioTab('workbench');
     window.WorkbenchModules?.refresh();
   }
 });

 initSkillsCatalog();

 $('#copyMachine').onclick=()=>copy($('#machineCode').value).catch(e=>toast(e.message,'error'));
 $('#loginForm').onsubmit=async event=>{event.preventDefault();$('#licenseReason').classList.remove('is-error');const button=$('#activateButton');button.disabled=true;try{await api('/api/license/activate',{method:'POST',body:JSON.stringify({code:$('#activationCode').value.trim()})});$('#activationCode').value='';await displayStatus();toast('登录成功');}catch(e){$('#licenseReason').textContent=e.message;$('#licenseReason').classList.add('is-error');}finally{button.disabled=false;}};
 $('#licenseFile').onchange=async e=>{try{const file=e.target.files[0];if(file?.size>20000)throw new Error('授权文件过大');if(file)$('#activationCode').value=await file.text();}catch(e){toast(e.message,'error');}finally{e.target.value='';}};
 $('#backToWorkbench').onclick=()=>displayStatus().catch(e=>toast(e.message,'error'));
 $('#settingsButton').onclick=()=>openSettings().catch(e=>toast(e.message,'error'));
 $('#licenseButton').onclick=async()=>{try{currentLicense=await api('/api/license/status');$('#licenseDetails').innerHTML=`<p>${esc(currentLicense.valid?'已激活':currentLicense.reason)}</p><p>授权编号：${esc(currentLicense.license_id||'—')}</p><label>机器码<textarea readonly rows="3">${esc(currentLicense.machine_code)}</textarea></label>`;$('#licenseDialog').showModal();}catch(e){toast(e.message,'error');}};
 const updateLicense=()=>{if(mounted)void moduleConfig.deactivate();lock('粘贴新的授权码，更新这台电脑的授权。');};
 $('#replaceLicense').onclick=updateLicense;$('#setupLicense').onclick=updateLicense;
 $('#toggleKey').onclick=()=>{$('#apiKey').type=$('#apiKey').type==='password'?'text':'password';$('#toggleKey').textContent=$('#apiKey').type==='password'?'显示':'隐藏';};
 $('#apiKey').oninput=()=>{$('#modelTestStatus').textContent='';$('#modelTestStatus').classList.remove('is-error');};
  $('#baseUrl').oninput=$('#modelName').oninput=()=>{$('#modelTestStatus').textContent='';$('#modelTestStatus').classList.remove('is-error');};
 $('#activationCode').oninput=()=>{if($('#licenseReason').classList.contains('is-error')){$('#licenseReason').textContent='';$('#licenseReason').classList.remove('is-error');}};
 $('#settingsForm').onsubmit=async event=>{event.preventDefault();const button=$('#testSave');button.disabled=true;$('#apiKey').disabled=true;$('#baseUrl').disabled=true;$('#modelName').disabled=true;$('#modelTestStatus').classList.remove('is-error');$('#modelTestStatus').textContent='正在测试连接，请稍候…';try{const result=await api('/api/writing-workbench/model/test-and-save',{method:'POST',body:JSON.stringify({api_key:$('#apiKey').value,base_url:$('#baseUrl').value,model:$('#modelName').value})});$('#apiKey').value='';$('#apiKey').placeholder=result.api_key_masked;$('#modelTestStatus').textContent=result.message;if(stage==='setup'){await displayStatus();}else{moduleConfig?.refresh();}toast(result.message);}catch(e){$('#modelTestStatus').textContent=e.message;$('#modelTestStatus').classList.add('is-error');}finally{button.disabled=false;$('#apiKey').disabled=false;$('#baseUrl').disabled=false;$('#modelName').disabled=false;}};
 await displayStatus();
 setInterval(async()=>{try{const status=await api('/api/license/status');if(!status.valid){currentLicense=status;lock(status.reason);}}catch{}},5000);
}

if(document.querySelector('#activation'))start().catch(e=>{$('#licenseReason').textContent=e.message;});
