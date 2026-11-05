"""Tauri device recovery policy; inference algorithms and settings stay unchanged."""
from threading import Event
from copy import deepcopy
from .detection import SHIMA, detect
from .yuchi_process import close_detector, detection_config


class DetectionCancelled(RuntimeError):
    pass


def detect_with_fallback(provider, source, working, device, cancel: Event, on_fallback=None, runner=None, recovery_enabled=None, on_progress=None):
    runner = runner or detect
    config = detection_config(SHIMA) if provider == SHIMA else None
    if config is not None: config['device'] = device
    if cancel.is_set(): raise DetectionCancelled('Scan cancelled before inference.')
    reason = None
    attempts = []
    try:
        batch = runner(provider, source, working, config=config)
        attempts.append({'requested_device': device, 'status': 'done'})
    except Exception as error:
        reason = str(error).splitlines()[0][:500]
        cuda_failure = any(code in reason.upper() for code in ('CUDA_ERROR:', 'CUDA_OOM:', 'CUDA_MEMORY:'))
        if provider != SHIMA or device == 'cpu' or not cuda_failure: raise
        attempts.append({'requested_device': device, 'status': 'failed', 'reason': reason})
        close_detector()
        if cancel.is_set(): raise DetectionCancelled('Scan cancelled before CPU fallback.')
        if on_fallback: on_fallback(reason)
        cpu_config = dict(config, device='cpu')
        batch = runner(provider, source, working, config=cpu_config)
        attempts.append({'requested_device': 'cpu', 'status': 'done'})
    if cancel.is_set(): raise DetectionCancelled('Scan cancelled; inference result discarded.')
    effective = batch.metadata.get('device')
    batch.metadata.update(requested_device=device, effective_device=effective, device_attempts=attempts,
                          cpu_fallback=reason is not None, fallback_reason=reason)
    if device == 'auto' and effective == 'cpu' and reason is None:
        batch.metadata['device_selection_reason'] = 'Auto selected CPU because CUDA was unavailable.'
    # Ordinary Scan includes recovery; crop verification explicitly disables recursion.
    enabled = True if recovery_enabled is None else recovery_enabled
    if provider == SHIMA and enabled:
        from .candidate_recovery import recover
        primary = batch
        try:
            # Recovery owns its candidate arrays and metadata. A failed attempt
            # cannot leak partial additions or mutations into the primary result.
            batch = recover(deepcopy(primary), source, working, cancel,
                lambda src,work: detect_with_fallback(provider,src,work,primary.metadata.get('device',device),cancel,on_fallback,runner,recovery_enabled=False),
                on_progress, DetectionCancelled)
        except DetectionCancelled:
            raise
        except Exception as error:
            if cancel.is_set():
                raise DetectionCancelled('Scan cancelled; primary and secondary results discarded.') from error
            batch = primary
            batch.metadata['automatic_recovery'] = {
                'experimental': True, 'status': 'failed', 'fallback_to_primary': True,
                'primary_count': len(primary.bubbles), 'added_count': 0,
                'error_kind': type(error).__name__,
                'reason': str(error).splitlines()[0][:500] if str(error) else type(error).__name__,
            }
        if cancel.is_set():
            raise DetectionCancelled('Scan cancelled; inference result discarded.')
    return batch
