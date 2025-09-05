"use client"

import React, { useMemo } from 'react'

export type Adjustable = {
  key: string
  type: 'number' | 'enum' | 'boolean' | 'text' | 'vector3'
  label?: string
  unit?: 'mm' | 'inch'
  min?: number
  max?: number
  step?: number
  options?: string[]
  required?: boolean
  hint?: string
  group?: string
  order?: number
}

function getByPath(obj: any, path: string): any {
  if (!obj) return undefined
  // Support both flattened dot-keys (e.g., 'body.diameter') and nested objects
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path]
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function setByPath(obj: any, path: string, value: any): any {
  const parts = path.split('.')
  const out = { ...(obj || {}) }
  let cur: any = out
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    cur[k] = typeof cur[k] === 'object' && cur[k] != null ? { ...cur[k] } : {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
  // Also maintain a flattened dot-key for downstream consumers that expect flat maps
  ;(out as any)[path] = value
  return out
}

type QuickSetupProps = {
  objectType?: string
  adjustables?: Adjustable[]
  params: Record<string, any>
  ask?: string[]
  options?: Record<string, string[]>
  dark?: boolean
  onParamsChange: (next: Record<string, any>) => void
  onApply?: () => void
}

export default function QuickSetup({ objectType, adjustables, params, ask, options, dark, onParamsChange, onApply }: QuickSetupProps) {
  const fields = useMemo(() => {
    const list = Array.isArray(adjustables) ? [...adjustables] : []
    const filtered = list.filter((f) => f && typeof f.key === 'string' && f.key.length > 0)
    return filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }, [adjustables])

  if (!fields || fields.length === 0) {
    return (
      <div className={`p-3 rounded border ${dark ? 'border-gray-600 bg-gray-800' : 'border-gray-300 bg-gray-50'}`}>
        <div className="text-sm font-semibold mb-1">Quick Setup</div>
        <div className="text-xs opacity-80">No adjustable parameters provided by the AI. Ask the assistant to specify which parameters to expose.</div>
      </div>
    )
  }

  return (
    <div className={`p-3 rounded border ${dark ? 'border-gray-600 bg-gray-800' : 'border-gray-300 bg-gray-50'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">Quick Setup{objectType ? ` — ${objectType}` : ''}</div>
        {ask && ask.length > 0 && (
          <div className="text-[11px] opacity-80">Needs input: {ask.join(', ')}</div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {fields.map((f) => {
          if (!f || typeof f.key !== 'string') return null
          const label = f.label || f.key
          const val = getByPath(params, f.key)
          const commonClass = `px-2 py-1 rounded border ${dark ? 'bg-gray-900 border-gray-700 text-white' : 'bg-white border-gray-400 text-gray-900'}`

          const onChangeNum = (e: React.ChangeEvent<HTMLInputElement>) => {
            const v = e.target.value
            const num = v === '' ? '' : Number(v)
            if (v !== '' && !Number.isFinite(num)) return
            onParamsChange(setByPath(params, f.key, v === '' ? '' : num))
          }
          const onChangeText = (e: React.ChangeEvent<HTMLInputElement>) => {
            onParamsChange(setByPath(params, f.key, e.target.value))
          }
          const onChangeBool = (e: React.ChangeEvent<HTMLInputElement>) => {
            onParamsChange(setByPath(params, f.key, e.target.checked))
          }
          const onChangeEnum = (e: React.ChangeEvent<HTMLSelectElement>) => {
            onParamsChange(setByPath(params, f.key, e.target.value))
          }

          return (
            <label key={f.key} className="flex flex-col gap-1 text-xs">
              <span className="opacity-80">
                {label}
                {f.unit ? ` (${f.unit})` : ''}
                {f.required ? ' *' : ''}
              </span>

              {f.type === 'number' && (
                <input type="number" inputMode="decimal" step={f.step ?? 1} min={f.min} max={f.max} className={commonClass} value={val ?? ''} onChange={onChangeNum} />
              )}
              {f.type === 'text' && <input type="text" className={commonClass} value={val ?? ''} onChange={onChangeText} />}
              {f.type === 'boolean' && (
                <input type="checkbox" className="h-4 w-4" checked={!!val} onChange={onChangeBool} />
              )}
              {f.type === 'enum' && (
                <select className={commonClass} value={val ?? ''} onChange={onChangeEnum}>
                  <option value="" disabled>
                    Select...
                  </option>
                  {(f.options || options?.[f.key] || []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )}

              {f.hint && <span className="opacity-60">{f.hint}</span>}
            </label>
          )
        })}
      </div>

      {onApply && (
        <div className="mt-3">
          <button onClick={onApply} className={`text-xs px-3 py-1 rounded border ${dark ? 'border-indigo-400 text-indigo-300 hover:bg-indigo-900/30' : 'border-indigo-600 text-indigo-700 hover:bg-indigo-50'}`}>
            Apply Changes
          </button>
        </div>
      )}
    </div>
  )
}
