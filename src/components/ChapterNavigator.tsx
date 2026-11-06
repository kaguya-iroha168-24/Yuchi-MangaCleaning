import type { ChapterState } from '../api';

export function ChapterNavigator({ chapter, selected, expanded, disabled, processingPageId, onExpand, onPage, onSelected, onAdd, onFolder }: {
  processingPageId?: string | null;
  chapter: ChapterState; selected: Set<string>; expanded: boolean; disabled: boolean;
  onExpand: () => void; onPage: (id: string) => void; onSelected: (id: string, checked: boolean) => void;
  onAdd: () => void; onFolder: () => void;
}) {
  return <aside className={`chapter-navigator ${expanded ? 'expanded' : ''}`} aria-label="Chapter pages">
    <div className="chapter-heading"><button onClick={onExpand} aria-expanded={expanded} title={expanded ? 'Narrow page navigator' : 'Expand page navigator'}>{expanded ? '‹ Pages' : 'Pages ›'}</button><span>{chapter.pages.length}</span></div>
    <div className="chapter-import"><button disabled={disabled} onClick={onAdd} title="Add images to this chapter">+ Pages</button>{expanded && <button disabled={disabled} onClick={onFolder}>Add folder</button>}</div>
    <div className="chapter-pages">{chapter.pages.map((page, index) => <div key={page.id} aria-busy={processingPageId===page.id} className={`chapter-page ${chapter.activePageId === page.id ? 'active' : ''}`}>
      <label className="page-queue-choice"><input type="checkbox" disabled={disabled} aria-label={`Include page ${index+1} in queue`} checked={selected.has(page.id)} onChange={event => onSelected(page.id,event.target.checked)} />{String(index+1).padStart(2,'0')}</label>
      <button disabled={disabled} aria-current={chapter.activePageId === page.id ? 'page' : undefined} aria-label={`Open page ${index+1}: ${page.name}`} onClick={() => onPage(page.id)}>
        <img loading="lazy" src={`data:image/png;base64,${page.thumbnail}`} alt="" />{expanded && <span title={page.name}>{page.name}</span>}
        <small>{processingPageId===page.id ? 'Processing…' : page.dirty ? 'Unsaved' : page.saved ? 'Saved' : 'Unmodified'}{page.bubbles ? ` · ${page.bubbles} bubbles` : ''}</small>
      </button>
    </div>)}</div>
  </aside>;
}
