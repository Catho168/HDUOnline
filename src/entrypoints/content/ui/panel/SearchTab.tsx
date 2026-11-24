/**
 * 本节助手「搜索」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 本节字幕全文检索（transcript.search），命中结果带时间点、点击跳转。
 */

import { formatClock } from '@/core/shared/utils';
import { Button, EmptyState } from '../components';
import { Icon } from '../icons';
import { uiStore, useUiStore } from '../store';
import { emptySearchTip } from '../learning/recentQueries';
import { markTextSegments } from '@/core/search/unified';

export function SearchTab({
  searchText,
  setSearchText,
  onSubmit,
}: {
  searchText: string;
  setSearchText: (value: string) => void;
  onSubmit: () => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const search = state.transcriptSearch;
  return (
    <div>
      <div className="hdu-search" style={{ maxWidth: 'none', width: '100%' }}>
        <Icon name="search" />
        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="搜索本节字幕内容…"
          aria-label="搜索本节字幕"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <Button size="small" variant="ghost" onClick={onSubmit} loading={search.loading}>搜索</Button>
      </div>
      <div style={{ marginTop: 10 }}>
        {search.query ? (
          <div className="hdu-hint" style={{ marginBottom: 8 }}>“{search.query}” · {search.results.length} 条结果</div>
        ) : null}
        {search.results.length === 0 ? (
          /* 空态文案随状态切换（第 249 轮空态模板化）：已有关键词时不再重复「输入关键词」引导 */
          <EmptyState
            icon="search"
            title={search.query ? '没有命中' : '在字幕中定位'}
            text={
              search.query
                ? // 建议词随长度变化（第 314 轮，检索域）：超长词点名长度（emptySearchTip 六端覆盖）
                  `${search.query.trim().length > 16 ? `${emptySearchTip(search.query)}；` : '换个关键词试试，'}命中结果会带上时间点，点击即可跳转。`
                : '输入关键词，命中结果会带上时间点，点击即可跳转。'
            }
          />
        ) : (
          <div className="hdu-transcript">
            {search.results.map((hit, i) => (
              <button type="button" key={`${hit.start}-${i}`} className="hdu-seg" onClick={() => actions.seek(hit.start)}>
                <span className="hdu-seg-time">{formatClock(hit.start)}</span>
                {/* 命中词高亮（第 315 轮，检索域）：与统一搜索 / 知识库同款 markTextSegments */}
                <span className="hdu-seg-text">
                  {search.query
                    ? markTextSegments(hit.text, search.query).map((part, si) =>
                        part.marked ? (
                          <mark key={si} className="hdu-search-mark">
                            {part.text}
                          </mark>
                        ) : (
                          <span key={si}>{part.text}</span>
                        ),
                      )
                    : hit.text}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
