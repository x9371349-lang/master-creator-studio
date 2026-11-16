// Pure local workspace transitions. The caller persists data; no network or models are used.
import {createTopic, safeSourceURL} from './topic-library-state.js';

export const STAGE_LABELS = {
  draft: '待审稿', reviewed: '审稿已通过', ready: '待发布', published: '已记录发布',
};

const checkFields = ['sourceChecked', 'titleChecked', 'rightsChecked'];
const metricFields = ['views', 'likes', 'comments', 'saves'];
const stamp = () => new Date().toISOString();
const snapshot = draft => ({titleSnapshot: draft.title ?? '', textSnapshot: draft.text ?? ''});
const matches = (record, draft) => Boolean(record &&
  record.textSnapshot === (draft?.text ?? '') && record.titleSnapshot === (draft?.title ?? ''));
const freshProduction = () => ({schemaVersion: 1, review: null, ready: null, publications: [], feedback: []});

function validateProduction(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      !Array.isArray(value.publications) || !Array.isArray(value.feedback) ||
      (value.review != null && (typeof value.review !== 'object' || Array.isArray(value.review))) ||
      (value.ready != null && (typeof value.ready !== 'object' || Array.isArray(value.ready)))) {
    throw new Error('制作与发布记录格式无法读取，请先导出工作台备份。');
  }
}

export function ensureProduction(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('稿件不存在。');
  validateProduction(draft.production);
  if (draft.production == null) draft.production = freshProduction();
  return draft.production;
}

export function ensureStudioWorkflow(data) {
  const drafts = draftList(data);
  // Validate the full collection before changing anything.
  for (const draft of drafts) validateProduction(draft.production);
  for (const draft of drafts) ensureProduction(draft);
  return data;
}

function draftList(data) {
  if (!Array.isArray(data?.drafts)) throw new Error('稿件列表无法读取。');
  return data.drafts;
}

export const getDraft = (data, id) => draftList(data).find(draft => draft.id === id);

function needDraft(data, id) {
  const draft = getDraft(data, id);
  if (!draft) throw new Error('稿件不存在或已在另一窗口变化，请刷新后重试。');
  validateProduction(draft.production);
  return draft;
}

function needText(draft) {
  if (typeof draft.text !== 'string' || !draft.text.trim()) throw new Error('请先填写稿件正文。');
  if (draft.title != null && typeof draft.title !== 'string') throw new Error('稿件标题必须为文字。');
}

function inputObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请提供有效的记录内容。');
  return value;
}

function textField(value, label, {required = false, max = 4000} = {}) {
  if (value != null && typeof value !== 'string') throw new Error(`${label}必须为文字。`);
  const result = (value ?? '').trim();
  if (required && !result) throw new Error(`请填写${label}。`);
  if (Array.from(result).length > max) throw new Error(`${label}超过 ${max} 字限制，请精简后保存。`);
  return result;
}

/** Current review, including a partially completed review; never mutates the draft. */
export function reviewFor(draft) {
  const review = draft?.production?.review;
  return matches(review, draft) ? review : null;
}

export function reviewPassed(draft) {
  const review = reviewFor(draft);
  return Boolean(review && checkFields.every(field => review[field] === true));
}

export function readyFor(draft) {
  const ready = draft?.production?.ready;
  return reviewPassed(draft) && matches(ready, draft) && ready.reviewId === reviewFor(draft).id ? ready : null;
}

function validPublication(record) {
  return Boolean(record && record.confirmed === true && typeof record.textSnapshot === 'string' &&
    typeof record.titleSnapshot === 'string' && typeof record.channel === 'string' && record.channel.trim() &&
    safeSourceURL(record.url));
}

/** Latest appended manual record. currentOnly limits it to the current title and body. */
export function latestPublicationFor(draft, {currentOnly = false} = {}) {
  const records = draft?.production?.publications;
  if (!Array.isArray(records)) return null;
  return records.findLast(record => validPublication(record) && (!currentOnly || matches(record, draft))) ?? null;
}

/** Latest appended feedback, optionally scoped to a publication ID. */
export function feedbackFor(draft, publicationId) {
  const records = draft?.production?.feedback;
  if (!Array.isArray(records)) return null;
  return records.findLast(record => record && (!publicationId || record.publicationId === publicationId)) ?? null;
}

export function stageFor(draft) {
  if (latestPublicationFor(draft, {currentOnly: true})) return 'published';
  if (readyFor(draft)) return 'ready';
  return reviewPassed(draft) ? 'reviewed' : 'draft';
}

export function saveReview(data, draftId, input = {}) {
  const draft = needDraft(data, draftId);
  needText(draft);
  inputObject(input);
  const checks = {};
  for (const field of checkFields) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error('审稿检查项需要明确勾选或取消。');
    checks[field] = input[field] === true;
  }
  const notes = textField(input.notes, '审稿备注');
  const now = stamp();
  const review = {id: crypto.randomUUID(), ...snapshot(draft), ...checks, notes, reviewedAt: now};
  const production = ensureProduction(draft);
  production.review = review;
  production.ready = null;
  production.updatedAt = now;
  return review;
}

export function markReady(data, draftId) {
  const draft = needDraft(data, draftId);
  needText(draft);
  if (!reviewPassed(draft)) throw new Error('请先完成当前标题与正文的来源、标题、素材权利三项审稿检查。');
  const existing = readyFor(draft);
  if (existing) return existing;
  const now = stamp();
  const ready = {id: crypto.randomUUID(), ...snapshot(draft), reviewId: reviewFor(draft).id, readyAt: now};
  const production = ensureProduction(draft);
  production.ready = ready;
  production.updatedAt = now;
  return ready;
}

export function recordPublication(data, draftId, input = {}) {
  const draft = needDraft(data, draftId);
  needText(draft);
  inputObject(input);
  if (input.confirmed !== true) throw new Error('请确认已在平台完成发布；此处只保存本地人工发布记录。');
  const channel = textField(input.channel, '发布渠道', {required: true, max: 100});
  if (typeof input.url !== 'string' || !safeSourceURL(input.url)) throw new Error('发布链接需要完整的 HTTP / HTTPS 地址，且不能包含登录凭据。');
  const url = safeSourceURL(input.url);
  const publishedAt = input.publishedAt == null || input.publishedAt === '' ? stamp() : input.publishedAt;
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) throw new Error('请填写有效的实际发布时间。');
  if (!readyFor(draft)) throw new Error('请先完成当前稿件的审稿并标记为待发布。');
  const now = stamp();
  const publication = {
    id: crypto.randomUUID(), ...snapshot(draft), channel, url,
    publishedAt: new Date(publishedAt).toISOString(), recordedAt: now,
    confirmed: true, kind: 'manual', label: '已记录发布',
    draftVersion: Number.isFinite(draft.version) ? draft.version : 0,
  };
  const production = ensureProduction(draft);
  production.publications.push(publication);
  production.updatedAt = now;
  return publication;
}

function metric(value, label) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}需为非负整数，或留空。`);
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw new Error(`${label}需为非负整数，或留空。`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}需为非负整数，或留空。`);
  return result;
}

export function saveFeedback(data, draftId, input = {}) {
  const draft = needDraft(data, draftId);
  inputObject(input);
  const publication = latestPublicationFor(draft);
  if (!publication) throw new Error('请先记录一次实际发布，再填写该次发布的表现。');
  const values = Object.fromEntries(metricFields.map(field => [field, metric(input[field], field)]));
  const notes = textField(input.notes, '复盘笔记');
  const lesson = textField(input.lesson, '复盘经验');
  const now = stamp();
  // Feedback describes the published snapshot, even after the working draft changes.
  const feedback = {
    id: crypto.randomUUID(), publicationId: publication.id,
    titleSnapshot: publication.titleSnapshot, textSnapshot: publication.textSnapshot,
    ...values, notes, lesson, recordedAt: now, verification: 'user-recorded',
  };
  const production = ensureProduction(draft);
  production.feedback.push(feedback);
  production.updatedAt = now;
  return feedback;
}

export function newTopicFromFeedback(data, draftId, input = {}) {
  const draft = needDraft(data, draftId);
  inputObject(input);
  const feedback = feedbackFor(draft);
  if (!feedback) throw new Error('请先保存复盘反馈，再创建后续选题。');
  const publication = draft.production.publications.find(record => record.id === feedback.publicationId);
  if (!validPublication(publication)) throw new Error('该复盘关联的发布记录无法读取。');
  const metricLabels = {views: '阅读/播放', likes: '点赞', comments: '评论', saves: '收藏'};
  const material = [
    '【来源说明】用户记录表现未经平台核验。以下为用户手动录入的发布记录与复盘，不代表平台验证或效果保证。',
    `发布渠道：${publication.channel}\n实际发布时间：${publication.publishedAt}\n发布链接：${publication.url}`,
    `【用户记录表现】\n${metricFields.map(field => `${metricLabels[field]}：${feedback[field] ?? '未录入'}`).join('\n')}`,
    `【复盘笔记（用户填写）】\n${feedback.notes || '未填写'}`,
    `【复盘经验（用户填写）】\n${feedback.lesson || '未填写'}`,
  ].join('\n\n');
  // createTopic owns library insertion and validation; do not insert the returned topic twice.
  return createTopic(data, {
    title: input.title, angle: input.angle, reader: input.reader, material,
    evidenceGaps: '表现数据由用户记录，未经平台核验；后续内容需另行核实事实与来源。',
    source: {title: `${publication.titleSnapshot || '稿件'} · 用户复盘`, url: publication.url,
      document_id: draft.id, document_version: publication.draftVersion, text: material},
  });
}

/** A filtered view of the existing drafts. Does not initialize or reorder stored data. */
export function queueFor(data, {stage = 'all', query = ''} = {}) {
  if (!['all', ...Object.keys(STAGE_LABELS)].includes(stage)) throw new Error('未知的稿件阶段。');
  const term = String(query).trim().toLocaleLowerCase();
  return draftList(data).filter(draft => (stage === 'all' || stageFor(draft) === stage) &&
    (!term || [draft.title, draft.text].join('\n').toLocaleLowerCase().includes(term)))
    .sort((a, b) => String(b.production?.updatedAt || b.updatedAt || '').localeCompare(String(a.production?.updatedAt || a.updatedAt || '')));
}
