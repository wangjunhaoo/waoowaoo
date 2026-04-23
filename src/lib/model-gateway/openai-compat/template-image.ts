import type { GenerateResult } from '@/lib/generators/base'
import type { OpenAICompatImageRequest } from '../types'
import {
  buildRenderedTemplateRequest,
  buildTemplateVariables,
  extractTemplateError,
  normalizeResponseJson,
  readJsonPath,
} from '@/lib/openai-compat-template-runtime'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { resolveOpenAICompatClientConfig } from './common'

const OPENAI_COMPAT_PROVIDER_PREFIX = 'openai-compatible:'
const PROVIDER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function encodeProviderToken(providerId: string): string {
  const value = providerId.trim()
  if (value.startsWith(OPENAI_COMPAT_PROVIDER_PREFIX)) {
    const uuid = value.slice(OPENAI_COMPAT_PROVIDER_PREFIX.length).trim()
    if (PROVIDER_UUID_PATTERN.test(uuid)) {
      return `u_${uuid.toLowerCase()}`
    }
  }
  return `b64_${Buffer.from(value, 'utf8').toString('base64url')}`
}

function encodeModelRef(modelRef: string): string {
  return Buffer.from(modelRef, 'utf8').toString('base64url')
}

function resolveModelRef(request: OpenAICompatImageRequest): string {
  const modelId = typeof request.modelId === 'string' ? request.modelId.trim() : ''
  if (modelId) return modelId
  const parsed = typeof request.modelKey === 'string' ? parseModelKeyStrict(request.modelKey) : null
  if (parsed?.modelId) return parsed.modelId
  throw new Error('OPENAI_COMPAT_IMAGE_MODEL_REF_REQUIRED')
}

function toMimeFromOutputFormat(outputFormat: string | undefined): string {
  const normalized = outputFormat?.trim().toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg'
  if (normalized === 'webp') return 'image/webp'
  return 'image/png'
}

function readRequestedOutputFormat(options: Record<string, unknown> | undefined): string | undefined {
  const rawOutputFormat = options?.outputFormat
  if (typeof rawOutputFormat === 'string' && rawOutputFormat.trim()) {
    return rawOutputFormat.trim()
  }
  const rawSnakeCaseOutputFormat = options?.output_format
  if (typeof rawSnakeCaseOutputFormat === 'string' && rawSnakeCaseOutputFormat.trim()) {
    return rawSnakeCaseOutputFormat.trim()
  }
  return undefined
}

function readPayloadOutputFormat(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const rawOutputFormat = payload.output_format
  if (typeof rawOutputFormat === 'string' && rawOutputFormat.trim()) {
    return rawOutputFormat.trim()
  }
  return undefined
}

function pathTargetsBase64(path: string | undefined): boolean {
  return typeof path === 'string' && path.includes('b64_json')
}

function normalizeTemplateOutputValue(input: {
  rawValue: string
  path?: string
  mimeType: string
}): string {
  const trimmed = input.rawValue.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('data:')) return trimmed
  if (pathTargetsBase64(input.path)) {
    return `data:${input.mimeType};base64,${trimmed}`
  }
  return trimmed
}

function readTemplateOutputUrls(input: {
  value: unknown
  path?: string
  fallbackMimeType: string
}): string[] {
  const values = Array.isArray(input.value) ? input.value : [input.value]
  const urls: string[] = []

  for (const item of values) {
    if (typeof item === 'string') {
      const normalized = normalizeTemplateOutputValue({
        rawValue: item,
        path: input.path,
        mimeType: input.fallbackMimeType,
      })
      if (normalized) {
        urls.push(normalized)
      }
      continue
    }

    if (!isRecord(item)) continue

    const url = item.url
    if (typeof url === 'string' && url.trim()) {
      urls.push(url.trim())
      continue
    }

    const b64Json = item.b64_json
    if (typeof b64Json === 'string' && b64Json.trim()) {
      const rawOutputFormat = item.output_format
      const mimeType = typeof rawOutputFormat === 'string' && rawOutputFormat.trim()
        ? toMimeFromOutputFormat(rawOutputFormat.trim())
        : input.fallbackMimeType
      urls.push(`data:${mimeType};base64,${b64Json.trim()}`)
    }
  }

  return urls
}

export async function generateImageViaOpenAICompatTemplate(
  request: OpenAICompatImageRequest,
): Promise<GenerateResult> {
  if (!request.template) {
    throw new Error('OPENAI_COMPAT_IMAGE_TEMPLATE_REQUIRED')
  }
  if (request.template.mediaType !== 'image') {
    throw new Error('OPENAI_COMPAT_IMAGE_TEMPLATE_MEDIA_TYPE_INVALID')
  }

  const config = await resolveOpenAICompatClientConfig(request.userId, request.providerId)
  const firstReference = Array.isArray(request.referenceImages) && request.referenceImages.length > 0
    ? request.referenceImages[0]
    : ''
  const variables = buildTemplateVariables({
    model: request.modelId || 'gpt-image-1',
    prompt: request.prompt,
    image: firstReference,
    images: request.referenceImages || [],
    aspectRatio: typeof request.options?.aspectRatio === 'string' ? request.options.aspectRatio : undefined,
    resolution: typeof request.options?.resolution === 'string' ? request.options.resolution : undefined,
    size: typeof request.options?.size === 'string' ? request.options.size : undefined,
    extra: request.options,
  })

  const createRequest = await buildRenderedTemplateRequest({
    baseUrl: config.baseUrl,
    endpoint: request.template.create,
    variables,
    defaultAuthHeader: `Bearer ${config.apiKey}`,
  })
  if (['POST', 'PUT', 'PATCH'].includes(createRequest.method) && !createRequest.body) {
    throw new Error('OPENAI_COMPAT_IMAGE_TEMPLATE_CREATE_BODY_REQUIRED')
  }
  const response = await fetch(createRequest.endpointUrl, {
    method: createRequest.method,
    headers: createRequest.headers,
    ...(createRequest.body ? { body: createRequest.body } : {}),
  })
  const rawText = await response.text().catch(() => '')
  const payload = normalizeResponseJson(rawText)
  if (!response.ok) {
    throw new Error(extractTemplateError(request.template, payload, response.status))
  }

  if (request.template.mode === 'sync') {
    const fallbackMimeType = toMimeFromOutputFormat(
      readPayloadOutputFormat(payload) || readRequestedOutputFormat(request.options),
    )
    const outputUrls = readTemplateOutputUrls({
      value: readJsonPath(payload, request.template.response.outputUrlsPath),
      path: request.template.response.outputUrlsPath,
      fallbackMimeType,
    })
    const outputUrl = readTemplateOutputUrls({
      value: readJsonPath(payload, request.template.response.outputUrlPath),
      path: request.template.response.outputUrlPath,
      fallbackMimeType,
    })[0]
    const fallbackOpenAIDataUrls = readTemplateOutputUrls({
      value: readJsonPath(payload, '$.data'),
      path: '$.data',
      fallbackMimeType,
    })
    const resolvedOutputUrls = outputUrls.length > 0
      ? outputUrls
      : outputUrl
        ? [outputUrl]
        : fallbackOpenAIDataUrls
    if (resolvedOutputUrls.length > 0) {
      const first = resolvedOutputUrls[0]
      return {
        success: true,
        imageUrl: first,
        ...(resolvedOutputUrls.length > 1 ? { imageUrls: resolvedOutputUrls } : {}),
      }
    }
    throw new Error('OPENAI_COMPAT_IMAGE_TEMPLATE_OUTPUT_NOT_FOUND')
  }

  const taskIdRaw = readJsonPath(payload, request.template.response.taskIdPath)
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : ''
  if (!taskId) {
    throw new Error('OPENAI_COMPAT_IMAGE_TEMPLATE_TASK_ID_NOT_FOUND')
  }
  const providerToken = encodeProviderToken(config.providerId)
  const modelRefToken = encodeModelRef(resolveModelRef(request))
  return {
    success: true,
    async: true,
    requestId: taskId,
    externalId: `OCOMPAT:IMAGE:${providerToken}:${modelRefToken}:${taskId}`,
  }
}
