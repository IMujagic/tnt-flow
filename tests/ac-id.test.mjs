import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acRegex } from '../plugins/think-and-type/scripts/lib/core.mjs';
import { tnt, write, makeProject, driveTo } from './helpers.mjs';

test('AC ids match the naming styles of common test frameworks', () => {
  const matches = {
    'JS/TS, JUnit @DisplayName, RSpec': "test('AC-1: adds numbers')",
    'pytest': 'def test_ac_1_adds_numbers():',
    'pytest (upper)': 'def test_AC_1_adds_numbers():',
    'Go': 'func TestAC1AddsNumbers(t *testing.T) {',
    'Rust': 'fn ac1_adds_numbers() {',
    'Java/C# method': 'void ac1_addsNumbers() {',
    'camelCase': 'void givenAc1AddsNumbers() {',
    'spaced': '"AC 1 adds numbers"',
  };
  for (const [style, line] of Object.entries(matches)) assert.ok(acRegex('AC-1').test(line), `${style}: ${line}`);
});

test('AC ids do not match other numbers or unrelated words', () => {
  const misses = ['AC-10: other criterion', 'test_ac_12_other', 'TestAC10Other', 'MAC1 address', 'HVAC1 unit'];
  for (const line of misses) assert.ok(!acRegex('AC-1').test(line), line);
  assert.ok(acRegex('AC-12').test('test_ac_12_other'));
});

test('red gate accepts identifier-style test names (Go/pytest/Rust style)', () => {
  const dir = makeProject();
  driveTo(dir, 'spec');
  tnt(dir, 'start', 'F-001');
  write(dir, 'app.test.mjs', `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('test_ac_1_add_returns_sum', async () => {
  const { add } = await import('./app.mjs');
  assert.equal(add(2, 3), 5);
});
`);
  tnt(dir, 'lock-tests', 'F-001', 'app.test.mjs');
  tnt(dir, 'run', 'F-001', 'red');
  const g = tnt(dir, 'gate', 'F-001', 'red');
  assert.equal(g.code, 0, g.out);
});
