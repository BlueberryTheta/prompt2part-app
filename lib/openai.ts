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
  const texts: string[] = []
  const seenTexts = new Set<string>()
  const seenObjects = new WeakSet<object>()

  const pushText = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || seenTexts.has(trimmed)) return
    seenTexts.add(trimmed)
    texts.push(trimmed)
  }

  const readTextLike = (value: any): void => {
    if (value == null) return
    if (typeof value === 'string') {
      pushText(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) readTextLike(item)
      return
    }
    if (typeof value === 'object') {
      if (seenObjects.has(value)) return
      seenObjects.add(value)
      if ('value' in value) readTextLike((value as any).value)
      if ('text' in value) readTextLike((value as any).text)
    }
  }

  const processContent = (content: any): void => {
    if (content == null) return
    if (Array.isArray(content)) {
      for (const item of content) processContent(item)
      return
    }
    if (typeof content !== 'object') return

    const type = (content as any).type
    if (type === 'message') {
      processContent((content as any).content)
      return
    }
    if (type === 'output_text' || type === 'text') {
      readTextLike((content as any).text ?? (content as any).value)
    }
  }

  const processResponse = (response: any): void => {
    if (response == null || typeof response !== 'object') return

    if (typeof (response as any).output_text === 'string') {
      readTextLike((response as any).output_text)
    } else if (Array.isArray((response as any).output_text)) {
      for (const item of (response as any).output_text) {
        readTextLike(item)
      }
    }

    if (Array.isArray((response as any).output)) {
      for (const item of (response as any).output) {
        processContent(item)
      }
    }
  }

  processResponse(payload)
  if (payload?.response && payload.response !== payload) {
    processResponse(payload.response)
  }
  if (Array.isArray(payload?.data)) {
    for (const item of payload.data) {
      processResponse(item)
    }
  }

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
  validate,
}: {
  messages: ChatMessage[]
  model?: string
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  validate?: (text: string) => boolean
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
          Math.max(4000, maxOutputTokens ? Math.floor(maxOutputTokens * 3) : 4000),
        ])
      ).sort((a, b) => a - b)

      let lastResponse: any = null
      let lastReason: string | undefined
      let fallbackText: string | null = null

      for (const [index, tokens] of tokenAttempts.entries()) {
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
        const reason = lastReason
        const isIncomplete = response?.status === 'incomplete'
        const isMaxTokenIncomplete = isIncomplete && reason === 'max_output_tokens'
        const hasNextAttempt = index < tokenAttempts.length - 1

        if (text) {
          if (validate && !validate(text)) {
            console.warn(DEBUG_PREFIX, 'responses.create text failed validation', {
              model: resolvedModel,
              preview: preview(text, 200),
              reason,
            })
            continue
          }
          if (isMaxTokenIncomplete && hasNextAttempt) {
            console.warn(DEBUG_PREFIX, 'responses.create incomplete due to max_output_tokens, retrying after partial text', {
              attemptedTokens: tokens,
              nextAttemptTokens: tokenAttempts[index + 1],
            })
            fallbackText = text
            continue
          }
          if (isIncomplete) {
            console.warn(DEBUG_PREFIX, 'responses.create returned incomplete status but extracted text', {
              reason,
            })
          }
          return text
        }

        if (!isMaxTokenIncomplete) {
          break
        }

        console.warn(DEBUG_PREFIX, 'responses.create incomplete due to max_output_tokens, retrying', {
          attemptedTokens: tokens,
          nextAttemptExists: hasNextAttempt,
        })
      }

      if (fallbackText) {
        console.warn(DEBUG_PREFIX, 'responses.create returning last incomplete text after retries', {
          reason: lastReason,
        })
        return fallbackText
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
    if (validate && !validate(text)) {
      console.warn(DEBUG_PREFIX, 'chat.completions text failed validation', {
        model: resolvedModel,
        preview: preview(text, 200),
      })
      throw new Error('OpenAI text failed validation')
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


