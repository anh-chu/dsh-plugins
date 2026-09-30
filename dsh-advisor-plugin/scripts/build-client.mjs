/**
 * build-client —— 把浏览器半打成 dsh ModuleLoader 要求的单文件 bundle：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require, module, exports) => {...} })
 *
 * 官方 client 包（tsdown 产物）就是这个形态：宿主经 /plugins/<pkg>/client.js
 * 取包的 exports['./client']，bundle 必须自注册。react/jsx-runtime 与
 * @deepseek-ai/* 一律外部化——运行时由 loader 的 require 提供。
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

// 注册 id 必须是**包名**：loader 按包名（即 loader 行名）解析并 materialize
// 模块，自注册 id 对不上就落在 "anything else → throw" 分支，条目报
// entry did not activate。上游这里硬编码成宿主半的 export name 'dsh-advisor'，
// 与包名 dsh-advisor-plugin 不一致——0.2 上浏览器半因此永远无法装载。
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error('package.json 缺少 name，无法生成模块注册 id')
const moduleId = pkg.name

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  // react 与 @deepseek-ai/* 由 ModuleLoader 的 require 提供
  external: ['react', 'react/*', '@deepseek-ai/*'],
  write: false,
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
// 官方 factory 只收 require 一个参数，module/exports 在体内自建
const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(moduleId)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  code,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

await mkdir('lib/client', { recursive: true })
await writeFile('lib/client/index.js', wrapped, 'utf8')
console.log(`[dsh-advisor] client bundle 已生成：lib/client/index.js（${wrapped.length} 字节，id=${moduleId}）`)
