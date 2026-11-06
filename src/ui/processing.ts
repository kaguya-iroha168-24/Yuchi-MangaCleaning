import type { ChapterState, Job } from '../api';

export function refreshJobImages(job: Job): boolean {
  return ['done','cancelled','failed'].includes(job.status) && (job.type==='process' || (job.status==='done' && job.type!=='ocr'));
}

export function processingPageIds(scope: string, chapter: ChapterState | null | undefined, selected: Set<string>): string[] {
  if(scope==='selected'){
    if(!selected.size)throw new Error('Select pages in the navigator first.');
    return [...selected];
  }
  return scope==='all' ? chapter?.pages.map(page=>page.id) ?? [] : [];
}

export function processingMessage(job: Job): string {
  if(job.type!=='process' || job.status!=='done')return '';
  const r=job.result ?? {};
  const processed=Number(r.processedPages ?? 0),attempted=Number(r.attemptedPages ?? processed);
  const pages=processed===attempted ? String(processed) : `${processed}/${attempted}`;
  return `${pages} pages processed · ${Number(r.cleanedRegions ?? 0)} regions cleaned · ${Number(r.skippedRegions ?? 0)} skipped${r.alreadyProcessedRegions ? ` · ${Number(r.alreadyProcessedRegions)} already clean` : ''}. Indonesian translation is not configured.`;
}
