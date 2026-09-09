import assert from 'node:assert/strict';

/**
 * Asserts that two floating-point numbers are within an epsilon tolerance.
 */
export function assertNear(actual: number, expected: number, tolerance: number = 0.001, message?: string): void {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tolerance,
    `${message || 'Value out of tolerance'}: actual=${actual}, expected=${expected}, diff=${diff}, maxTolerance=${tolerance}`
  );
}

/**
 * Asserts that a value lies strictly within [min, max].
 */
export function assertInRange(actual: number, min: number, max: number, message?: string): void {
  assert.ok(
    actual >= min && actual <= max,
    `${message || 'Value out of bounds'}: actual=${actual}, allowed=[${min}, ${max}]`
  );
}

/**
 * Asserts that an array of numbers is monotonically non-decreasing or strictly increasing.
 */
export function assertMonotonic(series: number[], strict: boolean = false, message?: string): void {
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const curr = series[i]!;
    if (strict) {
      assert.ok(curr > prev, `${message || 'Series not strictly increasing'} at index ${i}: prev=${prev}, curr=${curr}`);
    } else {
      assert.ok(curr >= prev, `${message || 'Series not monotonically non-decreasing'} at index ${i}: prev=${prev}, curr=${curr}`);
    }
  }
}

/**
 * Asserts referential equality (same memory address / identity).
 */
export function assertReferentialEqual<T>(actual: T, expected: T, message?: string): void {
  assert.strictEqual(
    actual,
    expected,
    `${message || 'Objects are not referentially identical (new instance created unexpectedly)'}`
  );
}

/**
 * Validates that an object contains all required properties of expected types.
 */
export function assertSchemaMatches(obj: any, schema: Record<string, string>, messagePrefix: string = 'Schema validation'): void {
  assert.ok(obj && typeof obj === 'object', `${messagePrefix}: Target must be a non-null object`);
  for (const [key, expectedType] of Object.entries(schema)) {
    assert.ok(key in obj, `${messagePrefix}: Missing required field "${key}"`);
    const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
    assert.strictEqual(
      actualType,
      expectedType,
      `${messagePrefix}: Field "${key}" type mismatch. Expected ${expectedType}, got ${actualType}`
    );
  }
}
