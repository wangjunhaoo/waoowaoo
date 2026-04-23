import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveConfigMock = vi.hoisted(() => vi.fn(async () => ({
  providerId: 'openai-compatible:test-provider',
  baseUrl: 'https://compat.example.com/v1',
  apiKey: 'sk-test',
})))

vi.mock('@/lib/model-gateway/openai-compat/common', () => ({
  resolveOpenAICompatClientConfig: resolveConfigMock,
}))

import { probeMediaTemplate } from '@/lib/user-api/model-template/probe'

describe('user-api model template probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts sync openai-style image responses with b64_json output', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'QUJDRA==', output_format: 'png' }],
    }), { status: 200 })) as unknown as typeof fetch

    const result = await probeMediaTemplate({
      userId: 'user-1',
      providerId: 'openai-compatible:test-provider',
      modelId: 'gpt-image-1',
      template: {
        version: 1,
        mediaType: 'image',
        mode: 'sync',
        create: {
          method: 'POST',
          path: '/images/generations',
          contentType: 'application/json',
          bodyTemplate: {
            model: '{{model}}',
            prompt: '{{prompt}}',
          },
        },
        response: {
          outputUrlPath: '$.data[0].url',
        },
      },
    })

    expect(result).toMatchObject({
      success: true,
      verified: true,
    })
  })
})
