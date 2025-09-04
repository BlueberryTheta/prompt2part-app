import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'edge'

// Reuse the sanitizer from generate route
import { sanitizeOpenSCAD } from '../generate/route'

export async function POST(req: NextRequest) {
  try {
    const { code } = (await req.json()) as { code?: string }
    const input = typeof code === 'string' ? code : ''
    const out = sanitizeOpenSCAD(input)
    return NextResponse.json({ code: out })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'sanitize error' }, { status: 500 })
  }
}

