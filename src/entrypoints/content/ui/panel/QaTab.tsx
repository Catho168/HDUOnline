/**
 * 本节助手「问答」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 基于本节字幕的时间点问答（建议问题、流式气泡、依据跳转、收藏回答、停止生成）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageEntity, ContextWindowPreset } from '@/core/shared/types';
import { formatClock, localDayKey } from '@/core/shared/utils';
import { hduMediaKey } from '@/core/shared/mediaRef';
import { buildChatsMarkdown } from '@/core/export/chats';
import { callOp } from '@/core/shared/client';
import { Button, Chip, EmptyState, Modal, Skeleton } from '../components';
import { Icon } from '../icons';
import { WindowPresetChips } from '../WindowPresetChips';
import { downloadTextFile } from '../reviewCards';
import { uiStore, useUiStore } from '../store';

/** 会话历史条目（qa.groups 返回） */
interface QaGroupInfo {
  groupId: string;
  title: string;
  lastAt: number;
  count: number;
}

const SUGGESTIONS = ['这一段的重点是什么？', '老师刚才举了什么例子？', '用更直白的话解释这个概念'];

export function QaTab({
  question,
  setQuestion,
  onSubmit,
  windowPreset,
  onSelectWindowPreset,
}: {
  question: string;
  setQuestion: (value: string) => void;
  onSubmit: () => void;
  /** 当前窗口档位（PlayPanel 顶层持有，问答 / 标注共用一档，同 B 站面板口径） */
  windowPreset: ContextWindowPreset;
  /** 档位点选上抛（父级登记「已交互」并更新受控值） */
  onSelectWindowPreset: (preset: ContextWindowPreset) => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.chats.length, state.streamingChatId]);

  // 会话历史管理（第 88 轮巡检）：列出/切换/删除本课次的历史问答会话
  const [historyOpen, setHistoryOpen] = useState(false);
  const [groups, setGroups] = useState<QaGroupInfo[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  // 清空全部（第 90 轮巡检）：两步确认
  const [clearAllArmed, setClearAllArmed] = useState(false);
  // 历史搜索（第 89 轮巡检）：按首问摘要过滤
  const [historyQuery, setHistoryQuery] = useState('');

  const loadGroups = useCallback(async () => {
    const courId = state.session?.courId;
    if (!courId) return;
    setGroupsLoading(true);
    try {
      const result = await callOp('qa.groups', { mediaKey: hduMediaKey(courId) });
      setGroups(Array.isArray(result) ? [...result].sort((a, b) => b.lastAt - a.lastAt) : []);
    } catch {
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  }, [state.session?.courId]);

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setHistoryQuery('');
    setClearAllArmed(false);
    void loadGroups();
  }, [loadGroups]);

  const openGroup = useCallback(
    async (groupId: string) => {
      await actions.loadChatGroup(groupId);
      setHistoryOpen(false);
    },
    [actions],
  );

  const deleteGroup = useCallback(
    async (groupId: string) => {
      await actions.deleteChatGroup(groupId);
      await loadGroups();
    },
    [actions, loadGroups],
  );

  // 历史搜索（第 89 轮巡检）：按首问摘要过滤
  const historyKeyword = historyQuery.trim().toLowerCase();
  const filteredGroups = groups.filter(
    (group) => !historyKeyword || group.title.toLowerCase().includes(historyKeyword),
  );

  // 清空全部会话（第 90 轮巡检）：qa.clear 不带 groupId 即清空本课次全部；两步确认
  const clearAllGroups = useCallback(async () => {
    const courId = state.session?.courId;
    if (!courId) return;
    await callOp('qa.clear', { mediaKey: hduMediaKey(courId) }).catch(() => undefined);
    actions.newChatGroup();
    setClearAllArmed(false);
    await loadGroups();
  }, [state.session?.courId, actions, loadGroups]);

  // 会话预览（第 104 轮巡检）：查看历史会话的消息（与 B站侧一致）；锚点时间可点击跳转
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(null);
  const [previewMessages, setPreviewMessages] = useState<ChatMessageEntity[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const previewGroup = useCallback(
    async (groupId: string) => {
      const courId = state.session?.courId;
      if (!courId) return;
      setPreviewGroupId(groupId);
      setPreviewLoading(true);
      const messages = await callOp('qa.list', { mediaKey: hduMediaKey(courId), groupId }).catch(() => [] as ChatMessageEntity[]);
      setPreviewMessages(messages);
      setPreviewLoading(false);
    },
    [state.session?.courId],
  );

  // 导出全部会话（第 91 轮巡检）：本课次全部消息 → Markdown
  const exportAllGroups = useCallback(async () => {
    const courId = state.session?.courId;
    if (!courId) return;
    const messages = await callOp('qa.list', { mediaKey: hduMediaKey(courId) }).catch(() => [] as ChatMessageEntity[]);
    downloadTextFile(
      `智慧课堂-问答记录-全部-${localDayKey()}.md`,
      buildChatsMarkdown(messages, state.session ? `${state.session.courseName} · ${state.session.courLabel}` : '本节课'),
    );
  }, [state.session]);

  /** 导出单个历史会话（第 89 轮巡检）：qa.list 拉该组消息 → buildChatsMarkdown 下载 */
  const exportGroup = useCallback(
    async (groupId: string, title: string) => {
      const courId = state.session?.courId;
      if (!courId) return;
      const messages = await callOp('qa.list', { mediaKey: hduMediaKey(courId), groupId }).catch(() => [] as ChatMessageEntity[]);
      downloadTextFile(
        `智慧课堂-问答记录-${localDayKey()}.md`,
        buildChatsMarkdown(
          messages,
          `${state.session ? `${state.session.courseName} · ${state.session.courLabel}` : '本节课'} · ${title}`,
        ),
      );
    },
    [state.session],
  );

  const segments = state.transcript?.segments ?? [];
  // 工具行（第 81 轮巡检起两种状态共用）：新对话 / 导出问答 / 窗口档位在有字幕与
  // 无字幕（转写前）状态下都可见——导出问答在无字幕时同样可用（chats 为空则禁用）
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      {segments.length > 0 ? (
        <>
          <Chip tone="info" icon="brain">基于本节字幕</Chip>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>锚点 {formatClock(state.currentTime)}</span>
        </>
      ) : null}
      <Button size="small" variant="ghost" icon="plus" onClick={() => actions.newChatGroup()}>
        新对话
      </Button>
      {/* 问答导出（第 81 轮巡检；第 82 轮升级为全量）：当前视频（mediaKey）全部会话
          消息 → Markdown 下载（纯函数序列化见 core/export/chats）；courId 缺失时回退
          当前会话消息 */}
      <Button
        size="small"
        variant="ghost"
        icon="download"
        disabled={state.chats.length === 0}
        onClick={() =>
          void (async () => {
            const courId = state.session?.courId;
            const messages = courId
              ? await callOp('qa.list', { mediaKey: hduMediaKey(courId) }).catch(() => state.chats)
              : state.chats;
            downloadTextFile(
              `智慧课堂-问答记录-${localDayKey()}.md`,
              buildChatsMarkdown(messages, state.session ? `${state.session.courseName} · ${state.session.courLabel}` : '本节课'),
            );
          })()
        }
      >
        导出问答
      </Button>
      {/* 会话历史（第 88 轮巡检）：列出/切换/删除本课次的历史问答会话 */}
      <Button size="small" variant="ghost" icon="clock" onClick={openHistory}>
        会话历史
      </Button>
      {/* 问答上下文窗口档位（第 29 轮 HDU 新增，B 站面板同款共享组件）：qa.ask 支持
          per-request windowPreset，点选仅影响本面板后续提问；初值=全局设置 */}
      <WindowPresetChips
        variant="hdu"
        value={windowPreset}
        onSelect={onSelectWindowPreset}
        ariaLabel="问答上下文窗口"
        titlePrefix="问答上下文窗口"
        titleSuffix="仅影响本面板问答；AI 标注生成亦可面板选档"
      />
    </div>
  );

  if (segments.length === 0) {
    // transcript 记录可能已存在但还没有文字（首个分片未完成/静音片段）：
    // 这时不能只显示"需要先生成字幕"，否则用户会以为转写没生效。
    const status = state.job?.status;
    const running = status === 'queued' || status === 'extracting' || status === 'transcribing';
    const paused = status === 'paused';
    const percent = Math.round((state.job?.progress ?? 0) * 100);
    // 已处理过音频但没有有效文字：与“还没开始转写”区分开，避免反复点生成
    const processedNoSpeech = !running && !paused && Boolean(state.transcript?.coverage?.length);
    return (
      <div>
        {toolbar}
        <EmptyState
          icon="message"
          title={
            running
              ? status === 'extracting'
                ? '正在提取音轨'
                : '字幕正在生成'
              : paused
                ? '转写已暂停'
                : processedNoSpeech
                  ? '没有识别到有效语音'
                  : '需要先生成字幕'
          }
          text={
            running
              ? `正在转写本节字幕（${percent}%），首个片段完成后即可提问。`
              : paused
                ? '转写已暂停，继续转写后才能基于字幕提问。'
                : processedNoSpeech
                  ? state.job?.warning ??
                    '本节音频已处理，但没有识别到有效文字。请确认当前播放机位是否包含声音（部分机位只有画面），或换一个区段重新生成。'
                  : '问答只依据本节字幕内容回答，并在回答中标注依据时间。'
          }
          action={
            running ? undefined : (
              <Button size="small" onClick={() => void actions.startTranscribe()}>
                {paused ? '继续转写' : '生成字幕'}
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div>
      {toolbar}
      {state.chats.length === 0 ? (
        <div>
          <EmptyState icon="message" title="就这一刻提问" text="问题会带上当前播放位置作为锚点。回答只依据附近字幕，不足时会明确告诉你。" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SUGGESTIONS.map((text) => (
              <button type="button" key={text} className="hdu-topic" style={{ textAlign: 'left' }} onClick={() => setQuestion(text)}>
                <span className="hdu-topic-sum">{text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="hdu-qa">
          {state.chats.map((chat) => (
            <ChatBubble key={chat.id} chat={chat} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="hdu-composer">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`就 ${formatClock(state.currentTime)} 这一刻提问…`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          {state.streamingChatId ? (
            <Button size="small" variant="ghost" icon="stop" onClick={() => void actions.abortAsk(state.streamingChatId!)}>
              停止
            </Button>
          ) : (
            <Button size="small" variant="primary" icon="send" onClick={onSubmit} loading={state.busy.ask} />
          )}
        </div>
        <div className="hdu-composer-hint">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span>·</span>
          <span>仅发送字幕文本与问题，视频数据不出本机</span>
        </div>
      </div>
      {/* 会话历史（第 88 轮巡检）：切换/删除本课次的历史问答会话；搜索与单会话导出为第 89 轮新增 */}
      <Modal
        open={historyOpen}
        title={groups.length > 0 ? `会话历史（${groups.length}）` : '会话历史'}
        onClose={() => setHistoryOpen(false)}
        width={440}
      >
        <div style={{ marginBottom: 10 }}>
          <input
            className="hdu-input"
            style={{ width: '100%' }}
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            placeholder="按首问内容过滤…"
            aria-label="过滤历史会话"
          />
        </div>
        {/* 清空全部（第 90 轮巡检）：两步确认；清空后当前会话一并清空。
            导出全部（第 91 轮巡检）：本课次全部会话 → Markdown */}
        {groups.length > 0 ? (
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button size="small" variant="ghost" icon="download" onClick={() => void exportAllGroups()}>
              导出全部
            </Button>
            {clearAllArmed ? (
              <Button size="small" onClick={() => void clearAllGroups()}>再点一次确认清空全部</Button>
            ) : (
              <Button size="small" variant="ghost" onClick={() => setClearAllArmed(true)}>清空全部</Button>
            )}
          </div>
        ) : null}
        {groupsLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={26} />
            <Skeleton height={26} />
          </div>
        ) : filteredGroups.length === 0 ? (
          <EmptyState
            icon="message"
            title={groups.length === 0 ? '暂无历史会话' : '没有匹配的会话'}
            text={groups.length === 0 ? '发起提问后会自动保存会话记录，可在这里切换或删除。' : '换个关键词试试。'}
          />
        ) : (
          <div className="hdu-list">
            {filteredGroups.map((group) => (
              <div className="hdu-list-row" key={group.groupId}>
                <div className="hdu-list-main">
                  <div className="hdu-list-title">{group.title || '（无标题）'}</div>
                  <div className="hdu-list-sub">
                    <span>{group.count} 条消息</span>
                    <span>{new Date(group.lastAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Button size="small" variant="ghost" onClick={() => void previewGroup(group.groupId)}>
                    {previewGroupId === group.groupId ? '收起' : '查看'}
                  </Button>
                  <Button size="small" variant="ghost" icon="play" onClick={() => void openGroup(group.groupId)}>
                    打开
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    icon="download"
                    onClick={() => void exportGroup(group.groupId, group.title || '历史会话')}
                  >
                    导出
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => void deleteGroup(group.groupId)}>
                    删除
                  </Button>
                </div>
                {previewGroupId === group.groupId ? (
                  <div className="hdu-qa-hist-preview">
                    {previewLoading ? (
                      <div className="hdu-hint">正在加载…</div>
                    ) : previewMessages.length === 0 ? (
                      <div className="hdu-hint">（无消息）</div>
                    ) : (
                      previewMessages.map((m) => (
                        <div key={m.id} className="hdu-qa-hist-msg">
                          <b>{m.role === 'user' ? '问' : '答'}</b>
                          {m.anchorTime != null ? (
                            <button
                              type="button"
                              className="hdu-qa-hist-anchor"
                              onClick={() => actions.seek(m.anchorTime!)}
                              title="跳转到该时间点"
                            >
                              @{formatClock(m.anchorTime)}
                            </button>
                          ) : null}
                          <p>{m.content || (m.insufficient ? '（字幕不足）' : '')}</p>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

function ChatBubble({ chat }: { chat: ChatMessageEntity }) {
  const actions = uiStore.actions;
  if (chat.role === 'user') {
    return (
      <div className="hdu-qa-msg user">
        <div className="hdu-qa-bubble">{chat.content}</div>
        <div className="hdu-qa-meta">
          {chat.anchorTime != null ? <span className="hdu-qa-anchor">@{formatClock(chat.anchorTime)}</span> : null}
          {chat.status === 'failed' ? <span style={{ color: 'var(--danger)' }}>发送失败</span> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="hdu-qa-msg ai">
      <div className="hdu-qa-bubble">
        {chat.content ||
          (chat.status === 'streaming' ? (
            <span className="hdu-spinner" />
          ) : chat.insufficient ? (
            '附近字幕不足以回答这个问题。可以换一种问法，或把进度拖到讲解该内容的区段再提问。'
          ) : (
            ''
          ))}
        {chat.status === 'streaming' ? <span className="hdu-dot warn" style={{ display: 'inline-block', marginLeft: 4 }} /> : null}
      </div>
      <div className="hdu-qa-meta">
        <Chip tone="accent" icon="spark">AI 生成</Chip>
        {chat.evidence ? (
          <button type="button" className="hdu-qa-evidence" onClick={() => actions.seek(chat.evidence!.start)}>
            <Icon name="target" size={10} /> 依据 {formatClock(chat.evidence.start)}–{formatClock(chat.evidence.end)}
          </button>
        ) : null}
        {chat.contextActual ? <span>上下文 {formatClock(chat.contextActual[0])}–{formatClock(chat.contextActual[1])}</span> : null}
        {chat.status === 'done' ? (
          <button type="button" className="hdu-icon-btn" style={{ width: 20, height: 20 }} onClick={() => void actions.favoriteChat(chat.id)} title="收藏这条回答">
            <Icon name="star" />
          </button>
        ) : null}
        {/* 复制回答（第 114 轮巡检）：copyText → 剪贴板 + toast */}
        {chat.status === 'done' && chat.content ? (
          <button type="button" className="hdu-qa-evidence" onClick={() => void actions.copyText(chat.content)} title="复制回答">
            复制
          </button>
        ) : null}
        {chat.insufficient ? <Chip tone="danger">字幕不足</Chip> : null}
      </div>
    </div>
  );
}
