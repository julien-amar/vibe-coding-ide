describe('strings', () => {
  test('joins words', () => {
    expect(['a', 'b'].join('-')).toBe('a-b')
  })

  test('fails on purpose', () => {
    expect('vibe'.toUpperCase()).toBe('Vibe')
  })

  describe('nested', () => {
    test('trims (spaces)', () => {
      expect('  x '.trim()).toBe('x')
    })
  })
})

test.skip('is skipped', () => {})
