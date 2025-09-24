import OpenAI from 'openai'
import type { ResponseInput } from 'openai/resources/responses/responses'

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'
const DEBUG_PREFIX = '[OpenAI]'

// Hard cap for output tokens to avoid very long/expensive calls.
// Override on Vercel/ENV with OPENAI_MAX_OUTPUT_TOKENS.
const MAX_OUTPUT_CAP = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || '') || 2000

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
  const metadataKeys = new Set([
    'background',
    'billing',
    'completion_tokens',
    'created_at',
    'error',
    'finish_reason',
    'id',
    'index',
    'instructions',
    'max_output_tokens',
    'max_tool_calls',
    'metadata',
    'model',
    'object',
    'parallel_tool_calls',
    'previous_response_id',
    'prompt_cache_key',
    'prompt_tokens',
    'reason',
    'safety_identifier',
    'service_tier',
    'status',
    'store',
    'temperature',
    'tool_choice',
    'tools',
    'top_logprobs',
    'top_p',
    'total_tokens',
    'truncation',
    'usage',
    'user',
    'type',
    'role',
  ])
  const skipPatterns = [
    /^rs_[A-Za-z0-9]+$/,
    /^resp_[A-Za-z0-9]+$/,
    /^run_[A-Za-z0-9]+$/,
    /^gpt-[\w-]+$/,
  ]

  const shouldSkip = (value: string, key?: string) => {
    const trimmed = value?.trim()
    if (!trimmed) return true
    if (key && metadataKeys.has(key)) return true
    for (const pattern of skipPatterns) {
      if (pattern.test(trimmed)) return true
    }
    return false
  }

  const addText = (candidate: string, key?: string) => {
    if (shouldSkip(candidate, key)) return
    const trimmed = candidate.trim()
    if (seenTexts.has(trimmed)) return
    seenTexts.add(trimmed)
    texts.push(trimmed)
  }

  const visit = (value: any, key?: string) => {
    if (value == null) return
    if (typeof value === 'string') {
      addText(value, key)
      return
    }
    if (typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (seenObjects.has(value)) return
    seenObjects.add(value)

    if ('text' in value) visit((value as any).text, 'text')
    if ('value' in value) visit((value as any).value, 'value')
    if ('output_text' in value) visit((value as any).output_text, 'output_text')
    if ('content' in value) visit((value as any).content, 'content')
    if ('message' in value) visit((value as any).message, 'message')
    if ('data' in value) visit((value as any).data, 'data')
    if ('response' in value) visit((value as any).response, 'response')

    for (const [childKey, childValue] of Object.entries(value)) {
      if (
        childKey === 'text' ||
        childKey === 'value' ||
        childKey === 'output_text' ||
        childKey === 'content' ||
        childKey === 'message' ||
        childKey === 'data' ||
        childKey === 'response'
      ) {
        continue
      }
      if (metadataKeys.has(childKey)) continue
      visit(childValue, childKey)
    }
  }

  visit(payload?.output_text, 'output_text')
  visit(payload?.text, 'text')
  visit(payload?.response?.output_text, 'output_text')
  visit(payload?.response?.text, 'text')
  visit(payload?.data, 'data')
  visit(payload?.output, 'output')
  visit(payload)

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
  responseFormatJson,
}: {
  messages: ChatMessage[]
  model?: string
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  validate?: (text: string) => boolean
  responseFormatJson?: boolean
}): Promise<string> {
  const client = ensureClient()
  const resolvedModel = model || DEFAULT_MODEL
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const startedAt = Date.now()
  const deadline = timeoutMs && timeoutMs > 0 ? startedAt + timeoutMs : 0

  const armTimeout = () => {
    if (!deadline) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      try { controller.abort() } catch {}
      return
    }
    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(() => controller.abort(), Math.max(1, remaining))
  }

  try {
    if (resolvedModel.toLowerCase().startsWith('gpt-5')) {
      // Keep the first attempt at the requested budget to reduce latency; second at cap if needed.
      const firstTokens = Math.min(MAX_OUTPUT_CAP, maxOutputTokens ?? 1200)
      const tokenAttempts = [firstTokens]
      if (firstTokens < MAX_OUTPUT_CAP) tokenAttempts.push(MAX_OUTPUT_CAP)

      let lastResponse: any = null
      let lastReason: string | undefined
      let fallbackText: string | null = null

      for (const [index, tokens] of tokenAttempts.entries()) {
        armTimeout()
        if (deadline && Date.now() >= deadline) {
          throw new Error('OpenAI request timed out')
        }
        // If this is not the first attempt, ensure we have enough time left to be useful
        if (index > 0 && deadline) {
          const remaining = deadline - Date.now()
          if (remaining < 8000) {
            console.warn(DEBUG_PREFIX, 'skipping retry due to low remaining time', { remainingMs: remaining })
            break
          }
        }

        console.debug(DEBUG_PREFIX, 'responses.create attempt', {
          model: resolvedModel,
          max_output_tokens: tokens,
        })

        const payload: any = {
          model: resolvedModel,
          input: toResponseInput(messages),
          max_output_tokens: tokens,
          // Let the server trim input if we exceed the model's context window
          truncation: 'auto' as any,
        }
        if (responseFormatJson) {
          ;(payload as any).text = { format: 'json_object' }
        }
        const response = await client.responses.create(
          payload,
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
        ...(responseFormatJson ? { response_format: { type: 'json_object' } as any } : {}),
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
    if (
      error?.name === 'AbortError' ||
      controller.signal.aborted ||
      (typeof error?.message === 'string' && error.message.toLowerCase().includes('aborted'))
    ) {
      throw new Error('OpenAI request timed out')
    }
    throw error
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}




