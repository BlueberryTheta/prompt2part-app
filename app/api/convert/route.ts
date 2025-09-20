import { NextRequest, NextResponse } from 'next/server'

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'

export async function POST(req: NextRequest) {
  const { prompt, history = [] } = await req.json()

  const messages = [
    {
      role: 'system',
      content: `You are a helpful assistant who generates OpenSCAD code for custom parts. 
If the user hasn't given enough information (e.g. dimensions, hole placement, etc.), 
ask them exactly what is needed. Only provide code once the design is clear.`,
    },
    ...history,
    {
      role: 'user',
      content: prompt,
    },
  ]

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 1000,
      }),
    })

    const data = await openaiRes.json()
    const reply = data.choices?.[0]?.message?.content || ''

    const isCode = reply.includes('module') || reply.includes(';') || reply.includes('//')

    return NextResponse.json({ 
      code: isCode ? reply : null, 
      question: isCode ? null : reply,
      role: 'assistant',
      content: reply
    })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to contact OpenAI' }, { status: 500 })
  }
}
