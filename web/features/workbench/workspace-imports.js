// Imports enter an inbox; only this editor instance saves its own workspace revision.
export function createImportBridge({api, getData, changed, flush, render, showToast}) {
  let timer = null, active = false, inflight = null, warned = false;
  function pull() {
    if (inflight) return inflight;
    inflight = (async () => {
      const result = await api('/api/creatorhub/imports');
      const items = result.items || [];
      if (!items.length) return [];
      const data = getData();
      if (!data) return [];
      let added = 0;
      for (const item of items) {
        if (!item.ref?.id) continue;
        if (!data.references.some(ref => ref.id === item.ref.id)) { data.references.unshift(item.ref); added++; }
        if (item.draft && !data.drafts.some(draft => draft.id === item.draft.id)) { data.drafts.unshift(item.draft); added++; }
        const currentSession = data.sessions.find(s => s.id === data.ui.activeSessionId) || data.sessions[0];
        if (currentSession && !currentSession.referenceIds.includes(item.ref.id)) { currentSession.referenceIds.push(item.ref.id); added++; }
      }
      if (added) { changed(); render(); }
      await flush();
      for (const item of items) await api(`/api/creatorhub/imports/${encodeURIComponent(item.id)}/ack`, {method:'POST'});
      warned = false;
      if (added) showToast(`已导入 ${items.length} 条素材，原有编辑已保留`);
      return items;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  async function tick() {
    if (!active) return;
    try { await pull(); } catch (error) {
      if (!warned) { showToast(`素材导入等待保存：${error.message}`, 'error'); warned = true; }
    }
    if (active) timer = setTimeout(tick, 6000);
  }
  return {
    pull,
    start() { if (active) return; active = true; void tick(); },
    stop() { active = false; clearTimeout(timer); },
  };
}
