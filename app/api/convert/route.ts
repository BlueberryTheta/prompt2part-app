import { NextRequest, NextResponse } from 'next/server'

import { ChatMessage, getOpenAIText } from '@/lib/openai'

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'

export async function POST(req: NextRequest) {
  const { prompt, history = [] } = await req.json()

  const historyMessages = Array.isArray(history)
    ? (history.filter((msg: any) => typeof msg?.role === 'string' && typeof msg?.content === 'string') as ChatMessage[])
    : []

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a helpful assistant who generates OpenSCAD code for custom parts.',
        "If the user hasn't given enough information (e.g. dimensions, hole placement, etc.),",
        'ask them exactly what is needed. Only provide code once the design is clear.',
      ].join('\n'),
    },
    ...historyMessages,
    {
      role: 'user',
      content: String(prompt ?? ''),
    },
  ]

  try {
    const reply = await getOpenAIText({
      messages,
      model: OPENAI_MODEL,
      maxOutputTokens: 1000,
      temperature: OPENAI_MODEL.toLowerCase().startsWith('gpt-5') ? undefined : 0.3,
    })

    const trimmed = reply.trim()
    if (!trimmed) {
      throw new Error('OpenAI did not return content')
    }

    const isCode = trimmed.includes('module') || trimmed.includes(';') || trimmed.includes('//')

    return NextResponse.json({
      code: isCode ? trimmed : null,
      question: isCode ? null : trimmed,
      role: 'assistant',
      content: trimmed,
    })
  } catch (err: any) {
    console.error('convert route OpenAI error:', err?.message ?? err)
    const message = (err?.message ?? 'Failed to contact OpenAI').toString()
    const status = message.includes('timed out') ? 504 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
