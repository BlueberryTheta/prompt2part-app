import OpenAI from 'openai'
import type { ResponseInput } from 'openai/resources/responses/responses'

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'

let cachedClient: OpenAI | null = null

function ensureClient() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured')
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey })
  }
  return cachedClient
}

function toResponseInput(messages: ChatMessage[]): ResponseInput {
  return messages.map(message => ({
    role: message.role,
    content: [{ type: 'input_text', text: message.content }],
    type: 'message',
  }))
}

function collectResponseText(payload: any): string {
  const pieces = new Set<string>()
  const seen = new WeakSet<object>()

  const visit = (value: any) => {
    if (value == null) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) pieces.add(trimmed)
      return
    }

    if (typeof value !== 'object') return

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    if (seen.has(value)) return
    seen.add(value)

    visit((value as any).output_text)
    visit((value as any).text)
    visit((value as any).value)
    visit((value as any).content)
    visit((value as any).message)

    for (const key of Object.keys(value)) {
      visit((value as any)[key])
    }
  }

  visit(payload?.output_text)
  visit(payload?.response?.output_text)
  visit(payload?.output)
  visit(payload)

  return Array.from(pieces).join('\n').trim()
}

export async function getOpenAIText({
  messages,
  model = DEFAULT_MODEL,
  maxOutputTokens = 1200,
  temperature,
  timeoutMs = 20000,
}: {
  messages: ChatMessage[]
  model?: string
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
}): Promise<string> {
  const client = ensureClient()
  const resolvedModel = model || DEFAULT_MODEL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (resolvedModel.toLowerCase().startsWith('gpt-5')) {
      const response = await client.responses.create(
        {
          model: resolvedModel,
          input: toResponseInput(messages),
          max_output_tokens: maxOutputTokens,
        },
        { signal: controller.signal }
      )

      const text = collectResponseText(response)
      if (!text) {
        throw new Error('OpenAI response contained no text output')
      }
      return text
    }

    const completion = await client.chat.completions.create(
      {
        model: resolvedModel,
        messages: messages.map(({ role, content }) => ({ role, content })),
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
      },
      { signal: controller.signal }
    )

    const text = completion.choices?.[0]?.message?.content?.trim()
    if (!text) {
      throw new Error('OpenAI chat completion returned no message content')
    }
    return text
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('OpenAI request timed out')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

