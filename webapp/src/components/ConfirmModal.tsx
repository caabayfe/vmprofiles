import { useState, type ReactNode } from 'react'
import { Button, Modal, T } from '@nttdsp/react-components'
import { ErrorText } from './fields'

export interface ConfirmState {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  action: () => Promise<unknown>
}

/** Destructive / state-changing confirmations — never window.confirm(). */
export function ConfirmModal({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const close = () => {
    setError(null)
    onClose()
  }
  const run = async () => {
    if (!state) return
    setBusy(true)
    setError(null)
    try {
      await state.action()
      close()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      show={!!state}
      handleClose={close}
      title={state?.title ?? ''}
      size="s"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button appearance="neutral" onClick={close}>{T.ACTION_CANCEL}</Button>
          <Button appearance={state?.danger ? 'danger' : 'primary'} onClick={run} disabled={busy}>
            {state?.confirmLabel}
          </Button>
        </div>
      }
    >
      <div>{state?.body}</div>
      <ErrorText error={error} />
    </Modal>
  )
}
