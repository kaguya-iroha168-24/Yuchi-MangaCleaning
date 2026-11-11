import type { ChapterState, Job } from '../api';

export function refreshJobImages(job: Job): boolean {
  return ['done','cancelled','failed'].includes(job.status) && (job.type==='process' || job.type==='detect-text' || (job.status==='done' && !['ocr','translate','detect-bubbles'].includes(job.type)));
}

export function processingPageIds(scope: string, chapter: ChapterState | null | undefined, selected: Set<string>): string[] {
  if(scope==='selected'){
    if(!selected.size)throw new Error('Select pages in the navigator first.');
    return [...selected];
  }
  return scope==='all' ? chapter?.pages.map(page=>page.id) ?? [] : [];
}

export function processingMessage(job: Job): string {
  if(!['process','detect-bubbles','detect-text'].includes(job.type) || job.status!=='done')return '';
  const r=job.result ?? {};
  const processed=Number(r.processedPages ?? 0),attempted=Number(r.attemptedPages ?? processed);
  const pages=processed===attempted ? String(processed) : `${processed}/${attempted}`;
  if(job.type==='detect-text')return `Text detection complete · ${Number(r.textRegionsDetected ?? 0)} text boxes · ${pages} ${processed === 1 && attempted === 1 ? 'page' : 'pages'}`;
  if(job.type==='detect-bubbles')return `Bubble detection complete · ${pages} ${processed === 1 && attempted === 1 ? 'page' : 'pages'}`;
  if(r.outputMode==='overlay')return `${pages} pages ready for overlay · add or translate dialogue to cover its linked source text.`;
  return `${pages} pages processed · ${Number(r.cleanedRegions ?? 0)} regions cleaned · ${Number(r.skippedRegions ?? 0)} skipped${r.alreadyProcessedRegions ? ` · ${Number(r.alreadyProcessedRegions)} already clean` : ''}.`;
}

export function textCleanHint(options: {
  showWorking?: boolean;
  textMode?: 'clean' | 'overlay';
  artwork?: 'working' | 'original' | 'hidden';
  artworkLocked?: boolean;
}): string {
  const steps: string[] = [];
  if (options.textMode === 'overlay') {
    steps.push('choose Clean in Settings → Editing → Text treatment');
  }
  if ((options.artwork ?? 'working') !== 'working') {
    steps.push('set Layers → Artwork in Editing and export to Cleaned / Working');
  }
  if (options.showWorking === false) {
    steps.push('enable the Layers → Cleaned / Working checkbox');
  }
  if (options.artworkLocked) {
    steps.push('uncheck Layers → Lock working artwork');
  }
  if (!steps.length) return '';
  const list = steps.length === 1
    ? steps[0]
    : steps.length === 2
      ? `${steps[0]} and ${steps[1]}`
      : `${steps.slice(0, -1).join(', ')}, and ${steps.at(-1)}`;
  return `To clean text, ${list}.`;
}
