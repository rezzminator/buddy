// Inline fixture characters for the unit tests; never the shipped characters/*.json.

export function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixy',
    name: 'Fixy',
    description: 'A test fixture.',
    persona: 'You are Fixy, a test fixture.',
    poses: {
      idle: [['(o)', '/|\\']],
      walkRight: [['(o)>', '/|\\'], ['(o)>', '/ \\']],
      yay: [['\\o/']],
    },
    lines: { greeting: ['Hi from Fixy.'] },
    ...overrides,
  };
}
