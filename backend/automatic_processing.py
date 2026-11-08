"""Page automation composes existing mask safety and the normal clean commit."""
from fastapi import HTTPException


def clean_page(m, check_cancel):
    """Clean eligible candidates once; caller holds the store lock and job guard."""
    store = m.store
    doc = store.require()
    summary = dict(cleanedIds=[], skipped=[], alreadyProcessedIds=[])
    proposals = []
    records = {}

    def skip(bubble, reasons):
        reasons = [str(reason)[:300] for reason in reasons]
        summary['skipped'].append(dict(id=bubble.id, reasons=reasons))
        records[bubble.id] = dict(status='skipped', reasons=reasons, semantic_verification=False)

    check_cancel()
    if doc.composition.get('artwork_locked'):
        for bubble in doc.bubbles:
            skip(bubble, ['Working artwork is locked.'])
        return summary
    for bubble in doc.bubbles:
        check_cancel()
        if bubble.provenance.get('excluded'):
            skip(bubble, ['Excluded from automatic processing.'])
            continue
        x, y, w, h = bubble.rect
        if (bubble.last_applied_mask is not None
                and bubble.cleaning_status in ('Cleaned', 'Needs Result Review')
                and not m.np.any(doc.mask[y:y+h, x:x+w])):
            summary['alreadyProcessedIds'].append(bubble.id)
            continue
        try:
            proposal = m.prepare_bubble(doc.working, bubble, doc.mask, doc.manual_mask)
            recovery = proposal.bubble.provenance.get('mask_recovery', {})
            if (tuple(proposal.bubble.rect) != tuple(bubble.rect)
                    or recovery.get('requires_confirmation')):
                skip(bubble, ['Recovered container geometry requires an explicit mask preview.'])
                continue
            if not m.np.any(proposal.mask):
                skip(bubble, ['No pending text pixels.'])
                continue
            safety = m.automatic_clean_safety(doc.working, proposal, doc.manual_mask)
        except (ValueError, TypeError) as error:
            skip(bubble, [str(error)])
            continue
        if not safety['safe']:
            skip(bubble, safety['reasons'])
            continue
        proposals.append(proposal)

    check_cancel()
    committed = False
    if proposals:
        mask = m.np.zeros_like(doc.mask)
        safe = m.np.zeros_like(doc.mask)
        for proposal in proposals:
            mask |= proposal.mask
            safe |= proposal.safe
        preview = m.prepare_preview(mask, safe, dict(strategy='automatic safe candidates',
            warnings=[], candidate_count=len(proposals), semantic_verification=False), None)
        store.preview['bubbleIds'] = [proposal.bubble.id for proposal in proposals]
        store.preview['proposals'] = proposals
        try:
            check_cancel()
            try:
                response = m.apply_clean(m.CleanRequest(previewId=preview['id'], method=m.AUTO), check_cancel=check_cancel)
            except (HTTPException, ValueError) as error:
                reason = str(error.detail) if isinstance(error, HTTPException) else str(error)
                summary['failure'] = reason[:300]
                for proposal in proposals:
                    skip(proposal.bubble, [reason])
                return summary
            committed = True
            summary['result'] = response['result']
            checks = response['result'].get('checks', {})
            for proposal in proposals:
                identifier = proposal.bubble.id
                assessment = checks.get(identifier, {})
                if assessment.get('status') == 'Failed':
                    skip(proposal.bubble, assessment.get('warnings') or ['No pixels changed for this candidate.'])
                else:
                    summary['cleanedIds'].append(identifier)
                    records[identifier] = dict(status='cleaned', resultStatus=assessment.get('status'),
                        semantic_verification=False)
        finally:
            if store.preview is not None and store.preview['id'] == preview['id']:
                store.preview = None

    updates = [(bubble, records[bubble.id]) for bubble in doc.bubbles
        if bubble.id in records and bubble.provenance.get('automatic_processing') != records[bubble.id]]
    if updates:
        if not committed:
            store.capture(('bubbles',))
        for bubble, record in updates:
            bubble.provenance = dict(bubble.provenance, automatic_processing=record)
        if not committed:
            doc.revision += 1
            doc.dirty = True
        store.preview = None
    return summary
