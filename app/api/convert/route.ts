import { NextRequest, NextResponse } from 'next/server'

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'

function toResponseMessage(msg: { role: string; content: string }) {
  const type = msg.role === 'assistant' ? 'output_text' : 'input_text'
  return {
    role: msg.role,
    content: [{ type, text: msg.content }],
  }
}

function extractTextValue(segment: any, seen = new Set<any>()): string {
  if (!segment || seen.has(segment)) return ''
  if (typeof segment === 'string') return segment
  if (typeof segment !== 'object') return ''
  seen.add(segment)

  if (Array.isArray(segment)) {
    return segment
      .map(part => extractTextValue(part, seen))
      .filter(Boolean)
      .join('')
  }

  const pieces: string[] = []
  const push = (value: any) => {
    const textValue = extractTextValue(value, seen)
    if (textValue && !pieces.includes(textValue)) pieces.push(textValue)
  }

  if ('output_text' in segment) push((segment as any).output_text)
  if ('value' in segment) push((segment as any).value)
  if ('text' in segment) push((segment as any).text)
  if ('content' in segment) push((segment as any).content)
  if ('data' in segment) push((segment as any).data)
  if ('message' in segment) push((segment as any).message)

  for (const value of Object.values(segment)) {
    if (value && typeof value === 'object') push(value)
  }

  return pieces.join('')
}

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
    const model = OPENAI_MODEL
    const useResponses = model.toLowerCase().startsWith('gpt-5')
    const endpoint = useResponses
      ? 'https://api.openai.com/v1/responses'
      : 'https://api.openai.com/v1/chat/completions'

    const body = useResponses
      ? {
          model,
          input: messages.map(toResponseMessage),
          modalities: ['text'],
          max_output_tokens: 1000,
          // Responses endpoint currently rejects temperature
        }
      : {
          model,
          messages,
          temperature: 0.3,
          max_tokens: 1000,
        }

    const openaiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY ?? ''),
        ...(useResponses ? { 'OpenAI-Beta': 'assistants=v2' } : {}),
      },
      body: JSON.stringify(body),
    })

    const raw = await openaiRes.text()
    if (!openaiRes.ok) {
      console.error('convert route OpenAI error:', openaiRes.status, openaiRes.statusText, raw.slice(0, 200))
      const status = openaiRes.status === 401 ? 401 : 502
      return NextResponse.json({ error: 'Failed to contact OpenAI' }, { status })
    }

    let data: any = {}
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        console.error('convert route OpenAI invalid JSON:', raw.slice(0, 200))
        return NextResponse.json({ error: 'Invalid response from OpenAI' }, { status: 502 })
      }
    }

    let reply = ''
    if (useResponses) {
      if (typeof data.output_text === 'string' && data.output_text.trim()) {
        reply = data.output_text.trim()
      } else {
        const outputs = Array.isArray(data.output) ? data.output : []
        const pieces: string[] = []
        for (const item of outputs) {
          const content = Array.isArray(item?.content) ? item.content : []
          for (const chunk of content) {
            if (chunk?.type === 'text' || chunk?.type === 'output_text') {
              const piece = extractTextValue(chunk?.text)
              if (piece) pieces.push(piece)
            }
          }
        }
        reply = pieces.map(part => part.trim()).filter(Boolean).join('\n').trim()
        if (!reply) {
          reply = extractTextValue(data)
        }
        reply = reply.trim()
      }
    } else {
      const content = data?.choices?.[0]?.message?.content
      if (typeof content === 'string') {
        reply = content
      } else if (Array.isArray(content)) {
        reply = content
          .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      reply = reply.trim()
    }

    if (!reply) {
      console.error('convert route OpenAI missing content:', raw.slice(0, 200))
      return NextResponse.json({ error: 'OpenAI did not return content' }, { status: 502 })
    }

    const isCode = reply.includes('module') || reply.includes(';') || reply.includes('//')

    return NextResponse.json({
      code: isCode ? reply : null,
      question: isCode ? null : reply,
      role: 'assistant',
      content: reply,
    })
  } catch (err: any) {
    console.error('convert route fatal error:', err?.message ?? err)
    return NextResponse.json({ error: 'Failed to contact OpenAI' }, { status: 500 })
  }
}
