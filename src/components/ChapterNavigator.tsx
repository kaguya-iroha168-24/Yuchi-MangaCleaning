import type { ChapterState } from '../api';

export function ChapterNavigator({ chapter, selected, expanded, disabled, pendingPageId, processingPageId, onExpand, onPage, onSelected, onAdd, onFolder }: {
  pendingPageId?: string | null;
  processingPageId?: string | null;
  chapter: ChapterState; selected: Set<string>; expanded: boolean; disabled: boolean;
  onExpand: () => void; onPage: (id: string) => void; onSelected: (id: string, checked: boolean) => void;
  onAdd: () => void; onFolder: () => void;
}) {
  const activeIndex = chapter.pages.findIndex(page => page.id === (pendingPageId ?? chapter.activePageId));
  return <aside className={`chapter-navigator ${expanded ? 'expanded' : ''}`} aria-label="Chapter pages">
    <div className="chapter-heading"><button onClick={onExpand} aria-expanded={expanded} title={expanded ? 'Narrow page navigator' : 'Expand page navigator'}>Pages ({activeIndex + 1}/{chapter.pages.length})</button><button disabled={disabled} onClick={onAdd} aria-label="Add pages" title="Add images to this chapter">+</button></div>
    {expanded && <div className="chapter-import"><button disabled={disabled} onClick={onFolder}>Add folder</button></div>}
    <div className="chapter-pages">{chapter.pages.map((page, index) => <div key={page.id} aria-busy={processingPageId===page.id || pendingPageId===page.id} className={`chapter-page ${(pendingPageId ?? chapter.activePageId) === page.id ? 'active' : ''}`}>
      <label className="page-queue-choice"><input type="checkbox" disabled={disabled} aria-label={`Include page ${index+1} in queue`} checked={selected.has(page.id)} onChange={event => onSelected(page.id,event.target.checked)} /></label>
      <button disabled={disabled && !pendingPageId} aria-current={chapter.activePageId === page.id ? 'page' : undefined} aria-label={`Open page ${index+1}: ${page.name}`} onClick={() => onPage(page.id)}>
        <img loading="lazy" src={`data:image/png;base64,${page.thumbnail}`} alt="" /><span className="chapter-page-label"><strong>Page {index + 1}{page.dirty ? ' ·' : ''}</strong><small title={page.name}>{page.name}</small>
        {(pendingPageId === page.id || processingPageId === page.id || expanded) && <small>{pendingPageId===page.id ? 'Loading…' : processingPageId===page.id ? 'Processing…' : `${page.bubbles} bubbles`}</small>}</span>
      </button>
    </div>)}</div>
  </aside>;
}
