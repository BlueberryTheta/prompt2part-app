import OpenAI from 'openai'
import type { ResponseInput } from 'openai/resources/responses/responses'

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'
const DEBUG_PREFIX = '[OpenAI]'

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

function preview(value: unknown, length = 600): string {
  try {
    const json = JSON.stringify(value)
    if (!json) return ''
    return json.length > length ? json.slice(0, length) + '...' : json
  } catch (err) {
    if (typeof value === 'string') return value.slice(0, length)
    return String(value)
  }
}

function collectResponseText(payload: any): string {
  const outputText = payload?.output_text ?? payload?.response?.output_text
  console.debug(DEBUG_PREFIX, 'collectResponseText: start', {
    type: typeof outputText,
    isArray: Array.isArray(outputText),
    preview: preview(outputText, 200),
  })

  if (typeof outputText === 'string') return outputText.trim()
  if (Array.isArray(outputText)) {
    const joined = outputText
      .map(part => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (joined) return joined
  }

  const pieces: string[] = []
  const seen = new WeakSet<object>()

  const visit = (value: any) => {
    if (value == null) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) pieces.push(trimmed)
      return
    }

    if (typeof value !== 'object') return

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    if (seen.has(value)) return
    seen.add(value)

    for (const key of Object.keys(value)) {
      visit((value as any)[key])
    }
  }

  visit(payload?.output)
  visit(payload)

  if (pieces.length > 0) {
    console.debug(DEBUG_PREFIX, 'collectResponseText: assembled pieces', {
      count: pieces.length,
      preview: pieces.slice(0, 3).map(text => text.slice(0, 200)),
    })
    return pieces.join('\n').trim()
  }

  console.warn(DEBUG_PREFIX, 'collectResponseText: no text extracted', {
    keys: payload ? Object.keys(payload) : [],
    preview: preview(payload, 400),
  })

  return ''
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

      console.debug(DEBUG_PREFIX, 'responses.create result', {
        model: resolvedModel,
        outputTextType: typeof response?.output_text,
        outputPreview: preview(response?.output_text, 200),
        outputLength: Array.isArray(response?.output_text) ? response.output_text.length : undefined,
        outputCount: Array.isArray(response?.output) ? response.output.length : undefined,
      })

      const text = collectResponseText(response)
      if (!text) {
        const debugPreview = preview(response, 400)
        throw new Error(`OpenAI response contained no text output (preview=${debugPreview})`)
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

    console.debug(DEBUG_PREFIX, 'chat.completions result', {
      model: resolvedModel,
      hasChoices: Array.isArray(completion?.choices),
      preview: preview(completion?.choices?.[0]?.message?.content, 200),
    })

    const text = completion.choices?.[0]?.message?.content?.trim()
    if (!text) {
      const debugPreview = preview(completion, 400)
      throw new Error(`OpenAI chat completion returned no message content (preview=${debugPreview})`)
    }
    return text
  } catch (error: any) {
    console.error(DEBUG_PREFIX, 'getOpenAIText error', {
      model: resolvedModel,
      message: error?.message,
      stack: error?.stack,
    })
    if (error?.name === 'AbortError') {
      throw new Error('OpenAI request timed out')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
