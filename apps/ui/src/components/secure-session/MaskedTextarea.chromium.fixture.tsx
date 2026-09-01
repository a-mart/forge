import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MaskedTextarea } from './MaskedTextarea'

const CANARY = 'AX-CANARY-DO-NOT-EXPOSE'
const EXPECTED_VALUE = `first\r\n${CANARY}\r\nlast`
const EXPECTED_CREATE_EDIT_HISTORY = [
  'a',
  'ab',
  'b',
  'ab',
  'a\nb',
  'ab',
  'z',
  EXPECTED_VALUE,
]

type Operation = 'create' | 'replace' | 'requestFulfillment'

declare global {
  interface Window {
    maskedTextareaAxFixture?: {
      status: () => {
        callbacksReceivedExactBytes: boolean
        editingCallbacksPreserveRawOffsets: boolean
        nativeValuesAreMasked: boolean
      }
    }
  }
}

export function Fixture() {
  const callbackValues = useRef<Partial<Record<Operation, string>>>({})
  const changeHistory = useRef<Record<Operation, string[]>>({
    create: [],
    replace: [],
    requestFulfillment: [],
  })
  const [createValue, setCreateValue] = useState('')
  const [replaceValue, setReplaceValue] = useState('')
  const [requestValue, setRequestValue] = useState('')

  useEffect(() => {
    window.maskedTextareaAxFixture = {
      status: () => ({
        callbacksReceivedExactBytes: (
          callbackValues.current.create === EXPECTED_VALUE
          && callbackValues.current.replace === EXPECTED_VALUE
          && callbackValues.current.requestFulfillment === EXPECTED_VALUE
        ),
        editingCallbacksPreserveRawOffsets: JSON.stringify(changeHistory.current.create)
          === JSON.stringify(EXPECTED_CREATE_EDIT_HISTORY),
        nativeValuesAreMasked: Array.from(document.querySelectorAll('textarea')).every((control) => (
          /^[•\n]*$/.test(control.value)
        )),
      }),
    }
    return () => {
      delete window.maskedTextareaAxFixture
    }
  }, [])

  const recordValueChange = useCallback((
    operation: Operation,
    setValue: (nextValue: string) => void,
    nextValue: string,
  ) => {
    changeHistory.current[operation].push(nextValue)
    setValue(nextValue)
  }, [])
  const handleCreateValueChange = useCallback((nextValue: string) => {
    recordValueChange('create', setCreateValue, nextValue)
  }, [recordValueChange])
  const handleReplaceValueChange = useCallback((nextValue: string) => {
    recordValueChange('replace', setReplaceValue, nextValue)
  }, [recordValueChange])
  const handleRequestValueChange = useCallback((nextValue: string) => {
    recordValueChange('requestFulfillment', setRequestValue, nextValue)
  }, [recordValueChange])

  return (
    <main>
      <section>
        <label htmlFor="create-value">Create private value</label>
        <MaskedTextarea
          id="create-value"
          aria-label="Create private value"
          value={createValue}
          onValueChange={handleCreateValueChange}
        />
        <button
          type="button"
          data-operation="create"
          onClick={() => {
            callbackValues.current.create = createValue
          }}
        >
          Submit Create private value
        </button>
      </section>
      <section>
        <label htmlFor="replace-value">Replace private value</label>
        <MaskedTextarea
          id="replace-value"
          aria-label="Replace private value"
          value={replaceValue}
          onValueChange={handleReplaceValueChange}
        />
        <button
          type="button"
          data-operation="replace"
          onClick={() => {
            callbackValues.current.replace = replaceValue
          }}
        >
          Submit Replace private value
        </button>
      </section>
      <section>
        <label htmlFor="requestFulfillment-value">Request private value</label>
        <MaskedTextarea
          id="requestFulfillment-value"
          aria-label="Request private value"
          value={requestValue}
          onValueChange={handleRequestValueChange}
        />
        <button
          type="button"
          data-operation="requestFulfillment"
          onClick={() => {
            callbackValues.current.requestFulfillment = requestValue
          }}
        >
          Submit Request private value
        </button>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
