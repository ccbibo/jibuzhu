import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

test('07 documented zero-dependency local command and launcher target the shipped server', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['start:local'], 'node --experimental-strip-types standalone/server.mjs');
  assert.match(read('README.md'), /npm run start:local/);
  assert.match(read('Start_記補住.command'), /node --experimental-strip-types standalone\/server\.mjs/);
  assert.ok(statSync(path.join(root, 'Start_記補住.command')).mode & 0o111);
  assert.match(read('standalone/server.mjs'), /server\.listen\(port,'127\.0\.0\.1'/);
});

test('07 documented service configuration keys agree with example and local loader', () => {
  const keys = [...read('.dev.vars.example').matchAll(/^([A-Z_]+)=/gm)].map(match => match[1]);
  assert.deepEqual(keys.sort(), ['AI_PROVIDER', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'NOTION_CLAIM_PAGE_ID', 'NOTION_DATA_SOURCE_ID', 'NOTION_TOKEN', 'OPENAI_API_KEY', 'OPENAI_MODEL']);
  for (const key of keys) {
    assert.ok(read('README.md').includes(key), `README must explain ${key}`);
    assert.ok(read('standalone/server.mjs').includes(`'${key}'`), `local loader must accept ${key}`);
  }
});

test('07 local configuration allowlist stays closed after the explicit claim-page addition', () => {
  const source = read('standalone/server.mjs');
  const loader = source.slice(source.indexOf('export function loadConfig()'), source.indexOf('export function sqliteStore(')).replace('export function', 'function');
  assert.ok(loader.startsWith('function loadConfig()'), 'run the actual shipped loader');
  const literal = loader.match(/const keys = (\[[^\]]+\]);/);
  assert.ok(literal, 'loader must declare an explicit allowlist');
  assert.deepEqual(Array.from(vm.runInNewContext(literal[1])).sort(), ['AI_PROVIDER', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'NOTION_CLAIM_PAGE_ID', 'NOTION_DATA_SOURCE_ID', 'NOTION_TOKEN', 'OPENAI_API_KEY', 'OPENAI_MODEL']);
  const config = vm.runInNewContext(`${loader}\nloadConfig()`, {
    root: '/synthetic', path,
    existsSync: () => true,
    readFileSync: () => 'OPENAI_API_KEY=synthetic-ai\nOPENAI_MODEL=synthetic-model\nNOTION_TOKEN=synthetic-token\nNOTION_DATA_SOURCE_ID=synthetic-source\nNOTION_CLAIM_PAGE_ID=synthetic-page\nUNAPPROVED_KEY=must-not-leak',
    process: { env: { UNAPPROVED_ENV: 'must-not-leak' } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    provider: 'openai', openaiKey: 'synthetic-ai', model: 'synthetic-model', notionToken: 'synthetic-token',
    dataSourceId: 'synthetic-source', claimPageId: 'synthetic-page',
  });
});

test('07 README relative Markdown links resolve to shipped files or directories', () => {
  for (const match of read('README.md').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert.ok(existsSync(path.resolve(root, target)), `missing README link: ${target}`);
  }
});

test('07 governance keeps complete-product gates separate from simulated passing tests', () => {
  const gate = read('docs/governance/夜間驗收門檻.md');
  for (const marker of ['真實AI語意問答品質驗收', '完整讀回來源與欄位', '桌面與手機', '候選版／等待本人接續', '不是真人或不同模型']) assert.ok(gate.includes(marker), marker);
  const collaboration = read('docs/governance/協作與上下文隔離規範.md');
  assert.match(collaboration, /不接入 DeepSeek/);
  assert.match(collaboration, /不是平台底層記憶或檔案權限的物理隔離保證/);
});
