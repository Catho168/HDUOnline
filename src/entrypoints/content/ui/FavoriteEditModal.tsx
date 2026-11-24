/**
 * 收藏编辑弹层（Dashboard 知识库与学习中心 LibraryView 共用的唯一实现，第 20 轮收口）。
 *
 * 背景：两处各有一份 FavoriteEditModal 且已漂移——学习中心为超集（新建文件夹 /
 * 置顶 / 弹层内删除两步确认 / 失败提示），Dashboard 为子集（仅备注 / 标签 / 移动
 * 文件夹，删除入口在卡片 ConfirmIconButton 上）。本组件以学习中心实现为底本收口，
 * 差异逐项裁决如下（照 VideoFavCard 第 19 轮先例）：
 *  - 回调 API：onSaved()（Dashboard）与 onDone(toast)（学习中心）统一为 onDone(toast)——
 *    成功文案（「已保存」/「已移入回收站」）由本组件给出，父级负责关窗、toast 与列表刷新；
 *  - 弹层内「移入回收站」两步确认删除：allowDelete，默认开启——fav-edit-modal.test.ts
 *    以无额外 props 渲染即点删除按钮，是既有行为契约；Dashboard 传 false 关闭；
 *  - 「置顶」勾选（allowPin）与「新建文件夹…」选项（allowCreateFolder）：默认开启；
 *    Dashboard 传 false 关闭，维持原三字段弹层；
 *  - patch 语义：pinned 仅在 allowPin 时随 patch 提交——Dashboard 路径不携带 pinned 键，
 *    避免保存时把卡片上的置顶状态意外改写；note/tags/folderId 三键两处本就同口径；
 *  - 保存 / 删除失败提示：onError 可选（学习中心接 pushToast(t, 'error')）；
 *    Dashboard 不传则失败时静默保持弹窗打开（原状：无 toast、不关窗、不回调 onDone）；
 *  - 保存按钮形态（size="small" 无 loading → icon="check" + loading，保存中禁用重复提交）、
 *    弹层宽度（默认 560 → 460）与字段顺序（备注/标签/文件夹 → 文件夹/(新建)/标签/备注/置顶）：
 *    无交互耦合的纯排版漂移，统一为学习中心样式。
 *
 * 全部动作复用现有 op（fav.update / folder.upsert / fav.softDelete），不新增 op、
 * 不复制校验逻辑；删除为软删除进回收站。删除不做打断式弹窗确认，沿用弹窗内
 * 两步确认模式（共享 useTwoStepConfirm）：第一次点击仅进入确认态（红色文案，
 * 3 秒未点自动复原），第二次点击才真正执行。
 */
import { useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { uuid } from '@/core/shared/utils';
import type { FavoriteEntity, FolderEntity } from '@/core/shared/types';
import { Button, Field, Modal, TextArea, TextInput, useTwoStepConfirm } from './components';

/** 文件夹下拉的「新建文件夹」哨兵值（不是真实文件夹 ID） */
const NEW_FOLDER_VALUE = '__new__';

export interface FavoriteEditModalProps {
  favorite: FavoriteEntity | null;
  folders: FolderEntity[];
  onClose: () => void;
  /** 保存 / 删除成功后回调（携带提示文案）：父级负责关窗、toast 与列表刷新 */
  onDone: (toast: string) => void;
  /** 弹层内「移入回收站」两步确认删除；默认开启，Dashboard 传 false（其删除入口在卡片上） */
  allowDelete?: boolean;
  /** 「置顶」勾选；默认开启，Dashboard 传 false（且保存 patch 不携带 pinned 键） */
  allowPin?: boolean;
  /** 「新建文件夹…」选项与名称输入；默认开启，Dashboard 传 false */
  allowCreateFolder?: boolean;
  /** 保存 / 删除失败提示；不传则失败时静默保持弹窗打开（Dashboard 原状） */
  onError?: (toast: string) => void;
  /** 标签输入联想（第 124 轮巡检）：既有高频标签名，注入 datalist；不传则无联想 */
  tagSuggestions?: string[];
}

export function FavoriteEditModal({
  favorite,
  folders,
  onClose,
  onDone,
  allowDelete = true,
  allowPin = true,
  allowCreateFolder = true,
  onError,
  tagSuggestions,
}: FavoriteEditModalProps) {
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [folderId, setFolderId] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  // 删除的两步确认态 + 3 秒复原定时器（共享 hook；弹窗关闭 / 切换编辑对象 / 卸载都要复位）
  const { confirming, step, reset } = useTwoStepConfirm();

  // 挂载 / favorite 变化（含关窗置 null 再打开另一条）时复位确认态；卸载清定时器由 hook 内置
  useEffect(() => {
    reset();
  }, [reset, favorite]);

  // 打开（或切换编辑对象）时回显现有值
  useEffect(() => {
    if (favorite) {
      setNote(favorite.note ?? '');
      setTags(favorite.tags.join(', '));
      setFolderId(favorite.folderId ?? '');
      setNewFolderName('');
      setPinned(favorite.pinned);
    }
  }, [favorite]);

  if (!favorite) return null;

  const save = async () => {
    setSaving(true);
    try {
      // 目标文件夹：选了「新建文件夹」则先建再移动；名称为空时保持原文件夹不变
      let targetFolderId: string | null = favorite.folderId ?? null;
      if (folderId === NEW_FOLDER_VALUE) {
        const name = newFolderName.trim();
        if (name) {
          // 与两处知识库筛选栏「文件夹」按钮相同的创建通道
          const created = { id: uuid(), name, orderIndex: folders.length, archived: false, createdAt: Date.now() };
          await callOp('folder.upsert', { folder: created });
          targetFolderId = created.id;
        }
      } else {
        targetFolderId = folderId || null;
      }
      // pinned 仅在展示置顶勾选的入口（学习中心）随 patch 提交；Dashboard 路径不携带该键，
      // 保持其原 patch 口径（备注 / 标签 / 文件夹三键），不误改卡片上的置顶状态
      await callOp('fav.update', {
        id: favorite.id,
        patch: {
          note: note.trim() || undefined,
          tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          folderId: targetFolderId,
          ...(allowPin ? { pinned } : {}),
        },
      });
      onDone('已保存');
    } catch {
      onError?.('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    // 两步确认：第一次点击只进入确认态（3 秒无操作自动复原），不发起删除
    if (!step()) return;
    try {
      await callOp('fav.softDelete', { ids: [favorite.id] });
      onDone('已移入回收站');
    } catch {
      onError?.('删除失败，请重试');
    }
  };

  return (
    <Modal
      open
      title="编辑收藏"
      onClose={onClose}
      width={460}
      footer={
        <>
          {allowDelete ? (
            <Button
              variant="ghost"
              icon="trash"
              className={confirming ? 'is-confirm' : ''}
              style={{ marginRight: 'auto' }}
              disabled={saving}
              onClick={() => void remove()}
            >
              {confirming ? '再点一次确认移入回收站' : '移入回收站'}
            </Button>
          ) : null}
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <Field label="标题">
        <TextInput value={favorite.snapshot.title} readOnly />
      </Field>
      <Field label="文件夹">
        <select
          className="hdu-select"
          value={folderId}
          onChange={(e) => {
            setFolderId(e.target.value);
            if (e.target.value !== NEW_FOLDER_VALUE) setNewFolderName('');
          }}
        >
          <option value="">未分组</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          {allowCreateFolder ? <option value={NEW_FOLDER_VALUE}>新建文件夹…</option> : null}
        </select>
      </Field>
      {allowCreateFolder && folderId === NEW_FOLDER_VALUE ? (
        <Field label="新文件夹名称" hint="保存时创建并移动到该文件夹">
          <TextInput value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="例如：期末复习" />
        </Field>
      ) : null}
      <Field label="标签" hint="用逗号分隔，例如：重点、考试、待复习">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} list={tagSuggestions && tagSuggestions.length > 0 ? 'hdu-tag-suggestions' : undefined} />
        {tagSuggestions && tagSuggestions.length > 0 ? (
          <datalist id="hdu-tag-suggestions">
            {tagSuggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        ) : null}
      </Field>
      <Field label="备注">
        <TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="写给未来的自己…" />
      </Field>
      {allowPin ? (
        <Field label="置顶">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
            <input type="checkbox" className="hdu-todo-check" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            在知识库中置顶显示
          </label>
        </Field>
      ) : null}
    </Modal>
  );
}
