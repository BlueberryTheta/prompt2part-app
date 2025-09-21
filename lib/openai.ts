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

  const texts: string[] = []
  const seenObjects = new WeakSet<object>()
  const seenTexts = new Set<string>()

  const addText = (candidate: any) => {
    if (candidate == null) return
    if (typeof candidate !== 'string') return
    const trimmed = candidate.trim()
    if (!trimmed) return
    if (seenTexts.has(trimmed)) return
    seenTexts.add(trimmed)
    texts.push(trimmed)
  }

  const walk = (value: any) => {
    if (value == null) return
    if (typeof value === 'string') {
      addText(value)
      return
    }
    if (typeof value !== 'object') return

    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }

    if (seenObjects.has(value)) return
    seenObjects.add(value)

    addText((value as any).text)
    addText((value as any).value)

    if (typeof (value as any).text === 'object') {
      walk((value as any).text)
    }

    if (Array.isArray((value as any).content)) {
      for (const item of (value as any).content) walk(item)
    }

    walk((value as any).output_text)
    walk((value as any).message)
    walk((value as any).data)
    walk((value as any).response)

    for (const key of Object.keys(value)) {
      if (['text', 'value', 'content', 'output_text', 'message', 'data', 'response'].includes(key)) continue
      walk((value as any)[key])
    }
  }

  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) walk(item)
  }

  walk(outputText)
  walk(payload)

  if (texts.length > 0) {
    console.debug(DEBUG_PREFIX, 'collectResponseText: assembled pieces', {
      count: texts.length,
      preview: texts.slice(0, 3).map(text => text.slice(0, 200)),
    })
    return texts.join('\n').trim()
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
      const tokenAttempts = Array.from(
        new Set([
          Math.max(1, maxOutputTokens ?? 1200),
          Math.max(2000, maxOutputTokens ? Math.floor(maxOutputTokens * 1.8) : 2000),
        ])
      )

      let lastResponse: any = null
      let lastReason: string | undefined

      for (const tokens of tokenAttempts) {
        console.debug(DEBUG_PREFIX, 'responses.create attempt', {
          model: resolvedModel,
          max_output_tokens: tokens,
        })

        const response = await client.responses.create(
          {
            model: resolvedModel,
            input: toResponseInput(messages),
            max_output_tokens: tokens,
          },
          { signal: controller.signal }
        )

        console.debug(DEBUG_PREFIX, 'responses.create result', {
          model: resolvedModel,
          status: response?.status,
          incompleteReason: response?.incomplete_details?.reason,
          outputTextType: typeof response?.output_text,
          outputPreview: preview(response?.output_text, 200),
          outputLength: Array.isArray(response?.output_text) ? response.output_text.length : undefined,
          outputCount: Array.isArray(response?.output) ? response.output.length : undefined,
        })

        lastResponse = response
        lastReason = response?.incomplete_details?.reason

        const text = collectResponseText(response)
        if (text) {
          if (response?.status === 'incomplete') {
            console.warn(DEBUG_PREFIX, 'responses.create returned incomplete status but extracted text', {
              reason: lastReason,
            })
          }
          return text
        }

        if (response?.status !== 'incomplete' || lastReason !== 'max_output_tokens') {
          break
        }

        console.warn(DEBUG_PREFIX, 'responses.create incomplete due to max_output_tokens, retrying', {
          attemptedTokens: tokens,
          nextAttemptExists: tokens !== tokenAttempts[tokenAttempts.length - 1],
        })
      }

      const previewPayload = preview(lastResponse, 400)
      const reason = lastReason ? ` reason=${lastReason}` : ''
      throw new Error(`OpenAI response contained no text output${reason} (preview=${previewPayload})`)
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
