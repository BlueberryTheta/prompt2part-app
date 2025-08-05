// app/api/generate/route.ts

import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }
type Spec = Record<string, any>

function sysPromptSpec(): string {
  return `
You are a CAD assistant that updates a structured SPEC JSON based on user input. You also determine the user's intent.

Your response MUST be a JSON with:
{
  "intent": "update" | "clarification" | "question",
  "spec": <updated spec as JSON>,
  "missing": [<string>],
  "questions": [<string>]
}

Rules:
- Only set intent to "update" if the SPEC has materially changed.
- Set intent to "clarification" if user input attempts to clarify previous fields.
- Set intent to "question" if the user is asking for advice or general feedback.
- Do NOT assume missing values; return them in "missing" and ask targeted "questions".
`.trim()
}

function sysPromptCode(): string {
  return `
You are an OpenSCAD generator. Based on a valid SPEC, generate OpenSCAD code ONLY.

Output ONLY the code. No explanations, markdown, or formatting.
Use mm as the default unit unless told otherwise.
Include reasonable variable names at the top for key dimensions.
`.trim()
}

function sysPromptQnA(): string {
  return `
You are a helpful CAD assistant. If the user asks a general question (e.g. how to improve a design), answer in clear, short language.

Do NOT generate code unless specifically asked. Provide bullet points or 1-2 sentences.
`.trim()
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function safeParseJSON(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*?\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch (err) {
        console.warn('⚠️ Partial match JSON parse failed:', err)
      }
    }
    throw new Error('❌ Spec content includes invalid or partial JSON (check for trailing commas, unquoted keys, or nulls).')
  }
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: currentSpec = {} }: { prompt: string; history?: Msg[]; spec?: Spec } =
      await req.json()

    // Stage 1: Extract intent + updated spec
    const messagesA: Msg[] = [
      { role: 'system', content: sysPromptSpec() },
      ...(history ?? []),
      { role: 'user', content: prompt },
    ]

    const resA = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 1000,
        messages: messagesA,
      }),
    })

    const dataA = await resA.json()
    const contentA = dataA?.choices?.[0]?.message?.content || ''
    console.log('🟡 Assistant spec response:\n', contentA)

    const parsed = safeParseJSON(contentA)
    const updatedSpec: Spec = parsed.spec || {}
    const missing: string[] = parsed.missing || []
    const questions: string[] = parsed.questions || []
    const intent: string = parsed.intent || 'update'

    // Handle missing info or clarifications
    if (missing.length > 0 || questions.length > 0 || intent === 'clarification') {
      return NextResponse.json({
        type: 'questions',
        intent,
        spec: updatedSpec,
        missing,
        questions,
        content: questions.length > 0
          ? `Before I can generate the model, I need:\n- ${missing.join('\n- ')}\n\nQuestions:\n- ${questions.join('\n- ')}`
          : `I still need:\n- ${missing.join('\n- ')}`,
      })
    }

    if (intent === 'question') {
      // Handle general advice question
      const qnaRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.7,
          max_tokens: 500,
          messages: [
            { role: 'system', content: sysPromptQnA() },
            { role: 'user', content: prompt },
          ],
        }),
      })
      const qnaData = await qnaRes.json()
      const answer = qnaData?.choices?.[0]?.message?.content || 'Let me know how I can help!'
      return NextResponse.json({
        type: 'answer',
        content: answer,
        spec: updatedSpec,
      })
    }

    // Only continue if intent is update and something actually changed
    const specChanged = !deepEqual(currentSpec, updatedSpec)

    if (!specChanged) {
      return NextResponse.json({
        type: 'nochange',
        spec: updatedSpec,
        content: 'ℹ️ The model is already up to date with your specifications.',
      })
    }

    // Stage 2: Generate OpenSCAD code
    const messagesB: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      { role: 'user', content: `SPEC:\n${JSON.stringify(updatedSpec, null, 2)}` },
    ]

    const resB = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.15,
        max_tokens: 1600,
        messages: messagesB,
      }),
    })

    const dataB = await resB.json()
    const code = dataB?.choices?.[0]?.message?.content || ''

    const isSCAD = /cube|cylinder|translate|difference|union|rotate/i.test(code)

    return NextResponse.json({
      type: isSCAD ? 'code' : 'invalid',
      spec: updatedSpec,
      code: isSCAD ? code : null,
      content: isSCAD ? '✅ Model updated based on your request.' : '⚠️ Could not generate code from the spec.',
    })
  } catch (err: any) {
    console.error('❌ /api/generate error:', err)
    return NextResponse.json(
      { error: err?.message || 'Unexpected error occurred in /api/generate' },
      { status: 500 }
    )
  }//comment
}
