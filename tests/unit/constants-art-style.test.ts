import { describe, expect, it } from 'vitest'
import { ART_STYLES, getArtStylePrompt, isArtStyleValue } from '@/lib/constants'

describe('constants art styles', () => {
  it('includes newly added chinese cg and xianxia styles', () => {
    expect(ART_STYLES.map((style) => style.value)).toEqual(expect.arrayContaining([
      'chinese-cg-painting',
      'guofeng-xianxia-3d-cg',
      'ink-xianxia-3d-cg',
    ]))
  })

  it('treats newly added styles as valid art style values', () => {
    expect(isArtStyleValue('chinese-cg-painting')).toBe(true)
    expect(isArtStyleValue('guofeng-xianxia-3d-cg')).toBe(true)
    expect(isArtStyleValue('ink-xianxia-3d-cg')).toBe(true)
  })

  it('returns localized prompts for newly added styles', () => {
    expect(getArtStylePrompt('chinese-cg-painting', 'zh')).toContain('超写实国风CG插画')
    expect(getArtStylePrompt('guofeng-xianxia-3d-cg', 'en')).toContain('Chinese xianxia 3D CG style')
    expect(getArtStylePrompt('ink-xianxia-3d-cg', 'zh')).toContain('水墨仙侠3D CG风格')
  })
})
