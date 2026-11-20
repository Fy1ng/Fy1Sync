import { useLayoutEffect, useRef, useState } from 'react'

export function InlineConfirmButtons({ label, onConfirm, onCancel, small = true, disabled, cancelDisabled = disabled, cancelFirst, cancelRef }: {
  label: string
  onConfirm: () => void
  onCancel: () => void
  small?: boolean
  disabled?: boolean
  cancelDisabled?: boolean
  cancelFirst?: boolean
  cancelRef?: React.Ref<HTMLButtonElement>
}): React.ReactNode {
  const buttonClass = small ? 'btn-quiet small' : 'btn-quiet'
  const confirm = <button type="button" className={`${buttonClass} is-danger`} disabled={disabled} onClick={onConfirm}>{label}</button>
  const cancel = <button type="button" className={buttonClass} disabled={cancelDisabled} ref={cancelRef} onClick={onCancel}>取消</button>
  return cancelFirst ? <>{cancel}{confirm}</> : <>{confirm}{cancel}</>
}

export function InlineConfirm({ label, confirmLabel, onConfirm, disabled = false, small = true, danger = true }: {
  label: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
  disabled?: boolean
  small?: boolean
  danger?: boolean
}): React.ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const group = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)

  const cancel = (): void => {
    restoreFocus.current = true
    setConfirming(false)
  }

  useLayoutEffect(() => {
    if (confirming) cancelButton.current?.focus()
    else if (restoreFocus.current) {
      restoreFocus.current = false
      trigger.current?.focus()
    }
  }, [confirming])

  useLayoutEffect(() => {
    const node = group.current
    if (!confirming || !node) return
    const dialog = node.closest('dialog')
    const scope = dialog ?? node
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Element)) return
      if (event.target.closest('dialog') !== dialog) return
      const focusedGroup = event.target.closest('[data-inline-confirm]')
      if (focusedGroup && focusedGroup !== node) return
      event.preventDefault()
      event.stopPropagation()
      if (!pending) cancel()
    }
    scope.addEventListener('keydown', onKey, true)
    return () => scope.removeEventListener('keydown', onKey, true)
  }, [confirming, pending])

  const submit = async (): Promise<void> => {
    if (pending || disabled) return
    group.current?.focus()
    setPending(true)
    try { await onConfirm() }
    finally {
      restoreFocus.current = group.current === document.activeElement
      setPending(false)
      setConfirming(false)
    }
  }

  return confirming
    ? <span className="inline-confirm" role="group" aria-label={confirmLabel} data-inline-confirm="" tabIndex={-1} ref={group}>
        <InlineConfirmButtons label={confirmLabel} small={small} disabled={disabled || pending} cancelDisabled={pending}
          cancelRef={cancelButton} onConfirm={() => void submit()} onCancel={cancel} />
      </span>
    : <button type="button" className={`btn-quiet${small ? ' small' : ''}${danger ? ' is-danger' : ''}`} ref={trigger}
        disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>
}
