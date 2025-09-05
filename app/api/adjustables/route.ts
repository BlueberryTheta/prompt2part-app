import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'edge'

type AnySpec = any

function findFeature(spec: AnySpec, featureId?: string, featureIndex?: number): any | null {
  const feats: any[] = Array.isArray(spec?.features) ? spec.features : []
  if (!feats.length) return null
  if (Number.isInteger(featureIndex) && featureIndex! >= 0 && featureIndex! < feats.length) {
    return feats[featureIndex!]
  }
  if (featureId) {
    return feats.find((f: any) => (f?.feature_id || f?.id) === featureId) || null
  }
  return feats[feats.length - 1] || null
}

function flattenParams(obj: any, base = '', outParams: Record<string, any> = {}) {
  if (!obj || typeof obj !== 'object') return outParams
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const path = base ? `${base}.${k}` : k
    if (typeof v === 'number' && Number.isFinite(v)) {
      outParams[path] = v
    } else if (typeof v === 'boolean') {
      outParams[path] = v
    } else if (v && typeof v === 'object') {
      flattenParams(v, path, outParams)
    }
  }
  return outParams
}

export async function POST(req: NextRequest) {
  try {
    const { spec, featureId, featureIndex } = (await req.json()) as { spec?: AnySpec; featureId?: string; featureIndex?: number }
    const feat = findFeature(spec, featureId, featureIndex)
    const params: Record<string, any> = feat ? flattenParams(feat) : {}

    const adjustables = Object.keys(params).map((key) => {
      const v = params[key]
      if (typeof v === 'number') return { key, type: 'number' as const, label: key }
      if (typeof v === 'boolean') return { key, type: 'boolean' as const, label: key }
      return null
    }).filter(Boolean)

    const objectType: string | undefined = (feat?.type && String(feat.type)) || (spec?.part_type && String(spec.part_type)) || undefined
    return NextResponse.json({ objectType, adjustables, adjust_params: params })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'adjustables error' }, { status: 500 })
  }
}
