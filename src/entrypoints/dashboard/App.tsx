import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { getDb } from '@/core/db';
import type { ExportJobRecord } from '@/core/db/schema';
import { loadSettings } from '@/core/shared/settings';
import type {
  AppSettings,
  DashboardReport,
  FavoriteEntity,
  FavoriteType,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  ScreenshotEntity,
  TagEntity,
} from '@/core/shared/types';
import { formatClock, formatDuration, localDayKey, shortDayLabel, uuid } from '@/core/shared/utils';
import { UI_CSS } from '../content/ui/styles';
import { BarChart, Button, Chip, EmptyState, Field, IconButton, Modal, Progress, SectionHead, Skeleton, TextArea, TextInput, cx } from '../content/ui/components';
import { Icon, type IconName } from '../content/ui/icons';

const EXTRA_CSS = String.raw`
html, body { margin: 0; height: 100%; background: #f5f1e8; }
body.dark { background: #131518; }
.hdu-dash { display: flex; height: 100vh; background: var(--paper); overflow: hidden; }
.hdu-dash-nav { width: 232px; flex: 0 0 232px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 60%, transparent); padding: 22px 14px; display: flex; flex-direction: column; gap: 24px; }
.hdu-dash-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.hdu-dash-content { flex: 1; overflow: auto; }
.hdu-dash-inner { max-width: 1120px; margin: 0 auto; padding: 30px 36px 90px; }
.hdu-dash .hdu-knowledge-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.hdu-shot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.hdu-shot { overflow: hidden; border-radius: 14px; border: 1px solid var(--line); background: var(--paper-2); }
.hdu-shot img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; background: var(--paper-3); }
.hdu-shot-meta { padding: 9px 11px; font-size: 10.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.hdu-review-row { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.hdu-review-row:last-child { border-bottom: 0; }
.hdu-kv { display: grid; grid-template-columns: 130px 1fr; gap: 8px 14px; font-size: 12px; }
.hdu-kv dt { color: var(--muted); }
.hdu-kv dd { margin: 0; }
.hdu-options-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; }
.hdu-options-row-main { flex: 1; min-width: 0; }
.hdu-options-row-title { font-size: 13px; font-weight: 500; }
.hdu-options-row-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.6; }
.hdu-options-row-side { flex: 0 0 auto; }
.hdu-dash .hdu-nav { flex-direction: column; gap: 3px; }
.hdu-dash .hdu-nav-item { width: 100%; }
@media (max-width: 820px) {
  .hdu-dash .hdu-nav { flex-direction: column; }
  .hdu-dash .hdu-nav-item { width: 100%; padding: 10px 12px; }
}
@media (max-width: 640px) { .hdu-dash-nav { width: 68px; flex-basis: 68px; } .hdu-dash-nav .hdu-nav-label, .hdu-dash-nav .hdu-nav-item span, .hdu-dash-nav .hdu-brand-name, .hdu-dash-nav .hdu-brand-sub { display: none; } .hdu-dash-nav .hdu-nav-item { justify-content: center; width: 100%; } .hdu-dash-inner { padding: 20px 18px 70px; } }
`;

type DashView = 'overview' | 'library' | 'review' | 'data';

const NAV: Array<{ key: DashView; label: string; icon: IconName }> = [
  { key: 'overview', label: '学习概览', icon: 'chart' },
  { key: 'library', label: '知识库', icon: 'library' },
  { key: 'review', label: '复习计划', icon: 'refresh' },
  { key: 'data', label: '数据管理', icon: 'layers' },
];

const FAVORITE_META: Record<FavoriteType, { label: string; icon: IconName }> = {
  time: { label: '时间点', icon: 'clock' },
  ai: { label: 'AI 回答', icon: 'spark' },
  outline: { label: '大纲', icon: 'list' },
  screenshot: { label: '截图', icon: 'camera' },
  note: { label: '笔记', icon: 'note' },
};

export function App() {
  const [view, setView] = useState<DashView>('overview');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const theme = useResolvedTheme(settings);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  return (
    <div className={cx('hdu-root', 'hdu-dash')} data-theme={theme}>
      <style>{UI_CSS + EXTRA_CSS}</style>
      <aside className="hdu-dash-nav">
        <div className="hdu-brand">
          <div className="hdu-brand-mark">学</div>
          <div>
            <div className="hdu-brand-name">学习看板</div>
            <div className="hdu-brand-sub">Dashboard</div>
          </div>
        </div>
        <nav className="hdu-nav">
          <div className="hdu-nav-label">我的数据</div>
          {NAV.map((item) => (
            <button type="button" key={item.key} className={cx('hdu-nav-item', view === item.key ? 'is-active' : '')} onClick={() => setView(item.key)}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="hdu-rail-foot">
          <Button size="small" variant="ghost" icon="settings" onClick={() => chrome.runtime.openOptionsPage()}>设置</Button>
          <div className="hdu-hint">全部数据只保存在本机</div>
        </div>
      </aside>
      <main className="hdu-dash-main">
        <div className="hdu-topbar">
          <div>
            <div className="hdu-topbar-title">{NAV.find((n) => n.key === view)?.label}</div>
            <div className="hdu-topbar-sub">
              {view === 'overview' ? '透明口径，只看有效学习' : view === 'library' ? '收藏、笔记与截图' : view === 'review' ? '间隔复习，别忘了回头' : '导出、导入、回收站与清理'}
            </div>
          </div>
          <div className="hdu-topbar-actions">{toast ? <Chip tone={toast.error ? 'danger' : 'jade'} icon={toast.error ? 'alert' : 'check'}>{toast.text}</Chip> : null}</div>
        </div>
        <div className="hdu-dash-content hdu-scroll">
          <div className="hdu-dash-inner">
            {view === 'overview' ? <Overview notify={notify} /> :
              view === 'library' ? <Library notify={notify} /> :
              view === 'review' ? <Review notify={notify} /> :
              <Data notify={notify} />}
          </div>
        </div>
      </main>
    </div>
  );
}

// ───────────────────────── 概览 ─────────────────────────

function Overview({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const r = await callOp('stats.report', { days: 90 }).catch(() => null);
    setReport(r);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (loading || !report) {
    return <div className="hdu-card pad"><Skeleton height={24} width="30%" /><div style={{ height: 16 }} /><Skeleton height={120} /></div>;
  }

  const last30 = report.days.slice(-30).map((d) => ({ label: shortDayLabel(d.date).slice(3), value: d.validSec, today: d.date === localDayKey() }));
  const maxCourse = Math.max(1, ...report.courses.map((c) => c.totalSec));
  const goalRatio = report.goal.weeklyTargetSec > 0 ? report.goal.weekSec / report.goal.weeklyTargetSec : 0;

  return (
    <>
      <div className="hdu-grid g4">
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="clock" /> 累计</div><div className="hdu-metric-value">{Math.round(report.totalSec / 3600)}<small>小时</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="chart" /> 本周</div><div className="hdu-metric-value">{(report.weekSec / 3600).toFixed(1)}<small>小时</small></div><div className="hdu-mini-foot">目标 {Math.round(goalRatio * 100)}%</div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="flame" /> 连续</div><div className="hdu-metric-value">{report.streakDays}<small>天</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="target" /> 本周打卡</div><div className="hdu-metric-value">{report.goal.hitDaysThisWeek}<small>天</small></div><div className="hdu-mini-foot">每日 ≥10 分钟</div></div>
      </div>

      <div className="hdu-section">
        <SectionHead title="近 30 天" sub="有效学习时长" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        <div className="hdu-card pad">
          <BarChart data={last30} height={180} />
          <div className="hdu-chart-legend" style={{ marginTop: 10 }}>
            <span><span className="hdu-dot ok" /> 今天</span>
            <span>仅播放中 + 前台可见 + 非挂机</span>
          </div>
        </div>
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="课程分布" sub="按有效时长" />
          <div className="hdu-dist">
            {report.courses.slice(0, 10).map((course) => (
              <div className="hdu-dist-row" key={course.teclId}>
                <span className="hdu-dist-name">{course.courseName}</span>
                <div className="hdu-dist-bar"><i style={{ width: `${(course.totalSec / maxCourse) * 100}%` }} /></div>
                <span className="hdu-dist-val">{formatDuration(course.totalSec)}</span>
              </div>
            ))}
            {report.courses.length === 0 ? <div className="hdu-hint">暂无数据</div> : null}
          </div>
        </div>
        <div className="hdu-card pad">
          <SectionHead title="本周目标" sub={`${(report.goal.weekSec / 3600).toFixed(1)} / ${(report.goal.weeklyTargetSec / 3600).toFixed(0)} 小时`} />
          <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
            <RingLarge value={Math.min(1, goalRatio)} />
          </div>
          <div className="hdu-hint" style={{ textAlign: 'center' }}>
            {goalRatio >= 1 ? '本周目标已达成' : `还差 ${formatDuration(Math.max(0, report.goal.weeklyTargetSec - report.goal.weekSec))}`}
          </div>
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="课次明细" sub="完看度 = 有效观看 / 课次时长" />
        <div className="hdu-card pad">
          {report.sessions.length === 0 ? <EmptyState icon="list" title="暂无课次数据" text="打开一节播放课并观看一段时间。" /> : (
            <div className="hdu-list">
              {report.sessions.slice(0, 40).map((session) => (
                <div className="hdu-list-row" key={session.courId}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{session.courseName}</div>
                    <div className="hdu-list-sub"><span>{session.courLabel}</span><span>{formatDuration(session.watchedSec)} / {formatDuration(session.durationSec)}</span></div>
                  </div>
                  <div className="hdu-list-side" style={{ minWidth: 170 }}>
                    <div style={{ width: 90 }}><Progress value={session.watchRatio} jade /></div>
                    <span className="hdu-time-badge">{Math.round(session.watchRatio * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button size="small" variant="ghost" icon="trash" onClick={async () => {
          if (!window.confirm('清空全部学习统计流水？此操作不可撤销。')) return;
          await callOp('stats.clear', {});
          notify('学习统计已清空');
          void reload();
        }}>清空统计</Button>
      </div>
    </>
  );
}

function RingLarge({ value }: { value: number }) {
  const size = 150;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="hdu-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="hdu-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle className="hdu-ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
      </svg>
      <span className="hdu-ring-label" style={{ fontSize: 26 }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

// ───────────────────────── 知识库 ─────────────────────────

function Library({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [favorites, setFavorites] = useState<FavoriteEntity[]>([]);
  const [folders, setFolders] = useState<FolderEntity[]>([]);
  const [tags, setTags] = useState<TagEntity[]>([]);
  const [notes, setNotes] = useState<NoteEntity[]>([]);
  const [shots, setShots] = useState<Array<Omit<ScreenshotEntity, 'blob'>>>([]);
  const [type, setType] = useState<FavoriteType | 'all'>('all');
  const [folder, setFolder] = useState<string | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<FavoriteEntity | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [f, fo, t, n, s] = await Promise.all([
      callOp('fav.list', { filter: { limit: 1000 } }).catch(() => []),
      callOp('folder.list', { includeArchived: true }).catch(() => []),
      callOp('tag.list', {}).catch(() => []),
      callOp('note.list', {}).catch(() => []),
      callOp('shot.list', {}).catch(() => []),
    ]);
    setFavorites(f);
    setFolders(fo);
    setTags(t);
    setNotes(n);
    setShots(s);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return favorites.filter((fav) => {
      if (type !== 'all' && fav.type !== type) return false;
      if (folder !== 'all' && (fav.folderId ?? '') !== folder) return false;
      if (q) {
        const hay = `${fav.snapshot.title} ${fav.snapshot.content} ${fav.note ?? ''} ${fav.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [favorites, type, folder, query]);

  const remove = async (fav: FavoriteEntity) => {
    if (!window.confirm('移入回收站？可在「数据管理 → 回收站」恢复。')) return;
    await callOp('fav.softDelete', { ids: [fav.id] });
    notify('已移入回收站');
    void reload();
  };

  return (
    <>
      <div className="hdu-filterbar">
        <div className="hdu-search">
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索收藏、笔记与标签…" />
        </div>
        <button type="button" className={cx('hdu-filter-pill', type === 'all' ? 'is-active' : '')} onClick={() => setType('all')}>全部</button>
        {(Object.keys(FAVORITE_META) as FavoriteType[]).map((key) => (
          <button type="button" key={key} className={cx('hdu-filter-pill', type === key ? 'is-active' : '')} onClick={() => setType(key)}>{FAVORITE_META[key].label}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button size="small" icon="plus" onClick={async () => {
            const name = window.prompt('新文件夹名称');
            if (!name?.trim()) return;
            await callOp('folder.upsert', { folder: { id: uuid(), name: name.trim(), orderIndex: folders.length, archived: false, createdAt: Date.now() } });
            notify('文件夹已创建');
            void reload();
          }}>文件夹</Button>
          <Button size="small" icon="download" onClick={async () => {
            const job = await callOp('export.build', { kind: 'cards', filter: { type: type === 'all' ? undefined : type } });
            await downloadJob(job.jobId);
          }}>导出卡片</Button>
        </div>
      </div>

      {folders.length > 0 ? (
        <div className="hdu-folder-row hdu-scroll-x">
          <button type="button" className={cx('hdu-folder', folder === 'all' ? 'is-active' : '')} onClick={() => setFolder('all')}>全部</button>
          {folders.map((f) => (
            <button type="button" key={f.id} className={cx('hdu-folder', folder === f.id ? 'is-active' : '')} onClick={() => setFolder(f.id)}>
              <Icon name="folder" size={13} /> {f.name}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? <div className="hdu-card pad"><Skeleton height={90} /></div> : filtered.length === 0 ? (
        <div className="hdu-card"><EmptyState icon="library" title="没有条目" text={favorites.length === 0 ? '在播放页收藏时间点、AI 回答、大纲或截图。' : '调整筛选条件试试。'} /></div>
      ) : (
        <div className="hdu-knowledge-grid">
          {filtered.map((fav) => {
            const meta = FAVORITE_META[fav.type];
            return (
              <div className="hdu-card hover hdu-knowledge-card" key={fav.id}>
                <div className="hdu-knowledge-head">
                  <Icon name={meta.icon} size={13} /> {meta.label}
                  {fav.anchorTime != null ? <span className="hdu-time-badge">{formatClock(fav.anchorTime)}</span> : null}
                  {fav.pinned ? <Chip tone="accent">置顶</Chip> : null}
                </div>
                <div className="hdu-knowledge-title">{fav.snapshot.title}</div>
                <div className="hdu-knowledge-text">{fav.snapshot.content || '（无正文）'}</div>
                {fav.note ? <div className="hdu-hint">备注：{fav.note}</div> : null}
                <div className="hdu-knowledge-foot">
                  {fav.tags.map((tag) => <span className="hdu-tag" key={tag}>{tag}</span>)}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    <IconButton icon="refresh" label="加入复习" onClick={async () => { await callOp('review.plan', { favoriteId: fav.id }); notify('已加入复习计划'); }} />
                    <IconButton icon={fav.pinned ? 'star' : 'star'} label="置顶" onClick={async () => { await callOp('fav.update', { id: fav.id, patch: { pinned: !fav.pinned } }); void reload(); }} />
                    <IconButton icon="settings" label="编辑" onClick={() => setEditing(fav)} />
                    <IconButton icon="trash" label="删除" onClick={() => void remove(fav)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {notes.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="时间戳笔记" sub={`${notes.length} 条`} />
          <div className="hdu-card pad">
            <div className="hdu-list">
              {notes.slice(0, 30).map((note) => (
                <div className="hdu-note" key={note.id}>
                  <span className="hdu-note-time">{formatClock(note.anchorTime)}</span>
                  <div className="hdu-note-body">
                    <div className="hdu-note-text">{note.text}</div>
                    <div className="hdu-hint">{localDayKey(new Date(note.createdAt))}</div>
                  </div>
                  <div className="hdu-note-actions">
                    <IconButton icon="star" label="转收藏" onClick={async () => { await callOp('note.toFavorite', { id: note.id }); notify('已转为收藏'); void reload(); }} />
                    <IconButton icon="trash" label="删除" onClick={async () => { await callOp('note.softDelete', { id: note.id }); notify('笔记已移入回收站'); void reload(); }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {shots.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="板书截图" sub={`${shots.length} 张`} />
          <div className="hdu-shot-grid">
            {shots.map((shot) => (
              <div className="hdu-shot" key={shot.id}>
                {shot.thumbDataUrl ? <img src={shot.thumbDataUrl} alt={shot.meta.courseName} loading="lazy" /> : <div style={{ aspectRatio: '16/9', background: 'var(--paper-3)' }} />}
                <div className="hdu-shot-meta">
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shot.meta.courseName}</span>
                  <span className="hdu-time-badge">{formatClock(shot.meta.anchorTime)}</span>
                  <IconButton icon="trash" label="删除截图" onClick={async () => { await callOp('shot.softDelete', { ids: [shot.id] }); notify('截图已移入回收站'); void reload(); }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="标签" sub={`${tags.length} 个`} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((tag) => <span className="hdu-tag" key={tag.id} style={{ padding: '3px 9px', fontSize: 11 }}>{tag.name}</span>)}
          </div>
        </div>
      ) : null}

      <FavoriteEditModal favorite={editing} folders={folders} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); notify('已保存'); }} />
    </>
  );
}

function FavoriteEditModal({
  favorite,
  folders,
  onClose,
  onSaved,
}: {
  favorite: FavoriteEntity | null;
  folders: FolderEntity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [folderId, setFolderId] = useState('');
  useEffect(() => {
    if (favorite) {
      setNote(favorite.note ?? '');
      setTags(favorite.tags.join(', '));
      setFolderId(favorite.folderId ?? '');
    }
  }, [favorite]);
  if (!favorite) return null;
  return (
    <Modal
      open
      title="编辑收藏"
      onClose={onClose}
      footer={<Button size="small" variant="primary" onClick={async () => {
        await callOp('fav.update', {
          id: favorite.id,
          patch: {
            note: note.trim() || undefined,
            tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
            folderId: folderId || null,
          },
        });
        onSaved();
      }}>保存</Button>}
    >
      <Field label="标题"><TextInput value={favorite.snapshot.title} readOnly /></Field>
      <Field label="备注"><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="写给未来的自己…" /></Field>
      <Field label="标签" hint="用逗号分隔，例如：重点、考试、待复习"><TextInput value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      <Field label="文件夹">
        <select className="hdu-select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">未分组</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

// ───────────────────────── 复习 ─────────────────────────

function Review({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [due, setDue] = useState<Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>>([]);
  const [stats, setStats] = useState<{ pending: number; todayDone: number; planned: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [d, s] = await Promise.all([callOp('review.due', {}).catch(() => []), callOp('review.stats', {}).catch(() => null)]);
    setDue(d);
    setStats(s);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="hdu-grid g3">
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="refresh" /> 待复习</div><div className="hdu-metric-value">{stats?.pending ?? 0}<small>条</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="check" /> 今日完成</div><div className="hdu-metric-value">{stats?.todayDone ?? 0}<small>条</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="calendar" /> 已排期</div><div className="hdu-metric-value">{stats?.planned ?? 0}<small>条</small></div></div>
      </div>
      <div className="hdu-section">
        <SectionHead title="今日待复习" sub="间隔模板：1 / 3 / 7 / 16 天" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        <div className="hdu-card pad">
          {loading ? <Skeleton height={80} /> : due.length === 0 ? (
            <EmptyState icon="refresh" title="今天没有待复习" text="在知识库中点击「加入复习」，按间隔模板自动排期。" />
          ) : (
            <div>
              {due.map((job) => (
                <div className="hdu-review-row" key={job.id}>
                  <div className="hdu-fav-icon"><Icon name={job.favorite ? FAVORITE_META[job.favorite.type].icon : 'star'} /></div>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{job.favorite?.snapshot.title ?? '（收藏已删除）'}</div>
                    <div className="hdu-list-sub">
                      <span>第 {job.round + 1} 轮</span>
                      {job.favorite?.anchorTime != null ? <span>{formatClock(job.favorite.anchorTime)}</span> : null}
                      <span>到期 {job.dueDate}</span>
                    </div>
                  </div>
                  <div className="hdu-list-side">
                    <Button size="small" variant="ghost" onClick={async () => { await callOp('review.complete', { jobId: job.id, status: 'skipped' }); notify('已跳过本轮'); void reload(); }}>跳过</Button>
                    <Button size="small" icon="check" onClick={async () => { await callOp('review.complete', { jobId: job.id, status: 'done' }); notify('完成一轮复习'); void reload(); }}>完成</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ───────────────────────── 数据 ─────────────────────────

function Data({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [usage, setUsage] = useState<{ indexedDbBytes: number; opfsBytes: number; quotaBytes: number; screenshotCount: number; transcriptCount: number; modelCached: boolean } | null>(null);
  const [trash, setTrash] = useState<Array<{ key: string; kind: string; id: string; title: string; deletedAt: number; expiresAt: number }>>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');

  const reload = useCallback(async () => {
    const [u, t] = await Promise.all([callOp('storage.usage', {}).catch(() => null), callOp('trash.list', {}).catch(() => [])]);
    setUsage(u);
    setTrash(t);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const exportData = async (kind: 'cards' | 'list' | 'backup') => {
    try {
      const job = await callOp('export.build', { kind, includeScreenshots: kind === 'backup' });
      await downloadJob(job.jobId);
      notify('导出已开始');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出失败', true);
    }
  };

  const importFile = async (file: File) => {
    setImporting(true);
    try {
      const isZip = file.name.toLowerCase().endsWith('.zip');
      const data = isZip ? new Uint8Array(await file.arrayBuffer()) : await file.text();
      const record: ExportJobRecord = {
        id: uuid(),
        kind: 'import',
        filename: file.name,
        mime: file.type || (isZip ? 'application/zip' : 'application/json'),
        data,
        size: file.size,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      };
      await (await getDb()).put('exportJobs', record);
      const result = await callOp('import.run', { jobId: record.id, mode: importMode });
      const total = Object.values(result.imported).reduce((a, b) => a + b, 0);
      notify(`导入完成，共写入 ${total} 条记录`);
      void reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : '导入失败（文件可能损坏）', true);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <div className="hdu-card">
        <SectionHead title="存储占用" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        {usage ? (
          <dl className="hdu-kv">
            <dt>IndexedDB</dt><dd>{formatBytes(usage.indexedDbBytes)} · {usage.transcriptCount} 节转写 · {usage.screenshotCount} 张截图</dd>
            <dt>模型 / OPFS</dt><dd>{formatBytes(usage.opfsBytes)} {usage.modelCached ? '· 已缓存模型' : ''}</dd>
            <dt>浏览器配额</dt><dd>{formatBytes(usage.quotaBytes)}</dd>
          </dl>
        ) : <div className="hdu-hint">读取中…</div>}
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="导出" sub="只含自产内容与可见元信息" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Button size="small" icon="download" onClick={() => void exportData('cards')}>复习卡片</Button>
            <Button size="small" icon="download" onClick={() => void exportData('list')}>收藏清单 CSV</Button>
            <Button size="small" icon="download" onClick={() => void exportData('backup')}>全量备份 ZIP</Button>
          </div>
          <div className="hdu-hint" style={{ marginTop: 10 }}>
            转写文本属于插件本地派生物，备份中会标注来源；不包含视频、音频或站点签名直链。
          </div>
        </div>
        <div className="hdu-card pad">
          <SectionHead title="导入" sub="JSON 备份或 ZIP" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select className="hdu-select" value={importMode} onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}>
              <option value="merge">合并</option>
              <option value="replace">替换现有数据</option>
            </select>
            <label className="hdu-btn small" style={{ cursor: 'pointer' }}>
              {importing ? '导入中…' : '选择文件'}
              <input
                type="file"
                accept=".json,.zip,application/json,application/zip"
                style={{ display: 'none' }}
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <div className="hdu-hint" style={{ marginTop: 10 }}>导入前会校验版本与结构；损坏文件会被拒绝，不会破坏现有数据。</div>
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="回收站" sub={`${trash.length} 条 · 保留 30 天`} actions={trash.length > 0 ? <Button size="small" variant="ghost" icon="trash" onClick={async () => { if (!window.confirm('清空回收站？不可恢复。')) return; await callOp('trash.purge', {}); notify('回收站已清空'); void reload(); }}>清空</Button> : undefined} />
        <div className="hdu-card pad">
          {trash.length === 0 ? <EmptyState icon="trash" title="回收站是空的" text="删除的收藏、笔记与截图会在这里保留 30 天。" /> : (
            <div className="hdu-list">
              {trash.map((item) => (
                <div className="hdu-list-row" key={item.key}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{item.title}</div>
                    <div className="hdu-list-sub"><span>{item.kind}</span><span>删除于 {localDayKey(item.deletedAt)}</span><span>到期 {localDayKey(item.expiresAt)}</span></div>
                  </div>
                  <div className="hdu-list-side">
                    <Button size="small" variant="ghost" onClick={async () => { await callOp('trash.restore', { keys: [item.key] }); notify('已恢复'); void reload(); }}>恢复</Button>
                    <Button size="small" variant="ghost" onClick={async () => { await callOp('trash.purge', { keys: [item.key] }); void reload(); }}>彻底删除</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="危险操作" sub="不可撤销" />
        <div className="hdu-card pad">
          <div className="hdu-options-row">
            <div className="hdu-options-row-main"><div className="hdu-options-row-title">清空全部本地数据</div><div className="hdu-options-row-sub">收藏、笔记、转写、统计、截图与 AI 缓存；模型文件也会被清除。</div></div>
            <div className="hdu-options-row-side">
              <Button size="small" variant="ghost" icon="trash" onClick={async () => {
                if (!window.confirm('清空全部本地数据？建议先导出备份。此操作不可撤销。')) return;
                await callOp('data.clear', { kinds: ['all'] });
                notify('全部本地数据已清空');
                void reload();
              }}>清空全部</Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

async function downloadJob(jobId: string): Promise<void> {
  const db = await getDb();
  const record = await db.get('exportJobs', jobId);
  if (!record) throw new Error('导出文件已过期，请重试');
  const blob = record.data instanceof Uint8Array ? new Blob([record.data as BlobPart], { type: record.mime }) : new Blob([String(record.data)], { type: record.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = record.filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function useResolvedTheme(settings: AppSettings | null): 'light' | 'dark' {
  const [dark, setDark] = useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  if (settings?.theme === 'dark') return 'dark';
  if (settings?.theme === 'light') return 'light';
  return dark ? 'dark' : 'light';
}
