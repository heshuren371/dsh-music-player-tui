#!/usr/bin/env node
/**
 * dsh-plugin.json 本地校验 —— 按 dsh-TUI 生态准入规范（dsh-ecosystem-spec v0.15）
 * 的 conformance suite 同一套机制逐项检查本插件清单：
 *
 *   TUI-PKG-001  @dsh-std/manifest Community v0.15 parse（固定 revision 的解析器）
 *   TUI-PKG-002  profile 声明闭环：protocol 坐标可解析、optional 必有 fallback、
 *                无 provides / requires.services、扩展贡献经 Manifest 投影校验
 *   TUI-HOST-001 用规范自带的 host descriptor 示例跑 admission decision
 *
 * 用法：
 *   node scripts/validate-manifest.mjs [spec 仓库路径]
 *
 * spec 仓库路径解析顺序：命令行参数 → 环境变量 DSH_ECOSYSTEM_SPEC_DIR →
 * 默认 ../references/dsh-ecosystem-spec（相对插件根目录）。
 * 要求 spec 仓库的 vendor/dsh-std 已构建（packages/<name>/lib/index.js 存在）；
 * 未构建时在 spec 仓库根执行：npm run build:std
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const specDir = path.resolve(
  process.argv[2]
    ?? process.env.DSH_ECOSYSTEM_SPEC_DIR
    ?? path.join(pluginRoot, '..', 'references', 'dsh-ecosystem-spec'),
)

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

if (!fs.existsSync(path.join(specDir, 'registry', 'registry-0.15.json'))) {
  fail('找不到 dsh-ecosystem-spec 仓库：' + specDir + '（用参数或 DSH_ECOSYSTEM_SPEC_DIR 指定）')
}

const stdRoot = path.join(specDir, 'vendor', 'dsh-std')
const stdPackages = ['core', 'connection', 'manifest', 'command', 'storage', 'messages', 'presentation', 'workspace', 'lifecycle']
for (const name of stdPackages) {
  if (!fs.existsSync(path.join(stdRoot, 'packages', name, 'lib', 'index.js'))) {
    fail('vendor/dsh-std 未构建（缺 ' + name + '/lib/index.js）；在 ' + specDir + ' 执行 npm run build:std')
  }
}

// 与 conformance/tests/std-modules.js 相同的装载方式：固定 revision 的 vendor 构建产物。
process.env.DSH_STD_ROOT = stdRoot
const std = await import(pathToFileURL(path.join(specDir, 'conformance', 'tests', 'std-modules.js')).href)
const {
  ProtocolCatalog, defineProtocolDeclaration,
  ManifestDefinitionCatalog, parseManifest, projectManifest,
  registerCommand, registerStorage, registerMessages, registerPresentation, registerWorkspace,
  facetModuleActivationDefinition,
} = std
const { registerProfileProtocols, registerTuiContributionExtensions } = await import(
  pathToFileURL(path.join(specDir, 'protocols', 'profile-definitions.js')).href
)

const loadJson = relative => JSON.parse(fs.readFileSync(path.join(specDir, relative), 'utf8'))
const profile = loadJson('registry/registry-0.15.json')
const permissionRegistry = loadJson('registry/permissions-0.1.json')
const facetApiVersions = profile.facetApiVersions ?? []
const profileEntries = [...profile.imports, ...profile.definitions]
const coordinateKey = value => (value.apiVersion ?? value.coordinates.apiVersion) + '#' + (value.kind ?? value.coordinates.kind)
const familyKey = value => (value.apiVersion ?? value.coordinates.apiVersion).split('/')[0] + '#' + (value.kind ?? value.coordinates.kind)
const byCoordinate = new Map(profileEntries.map(entry => [coordinateKey(entry.coordinates), entry]))
const byFamily = new Map(profileEntries.map(entry => [familyKey(entry.coordinates), entry]))
const byName = new Map(profileEntries.filter(entry => entry.name !== undefined).map(entry => [entry.name, entry]))

const protocols = new ProtocolCatalog({ name: 'dsh-tui-admission', version: '0.15' })
const manifestDefinitions = new ManifestDefinitionCatalog({ name: 'dsh-tui-admission', version: '0.15' })
manifestDefinitions.registerActivation(facetModuleActivationDefinition)
registerCommand(protocols, manifestDefinitions)
registerStorage(protocols)
registerMessages(protocols)
registerPresentation(protocols)
registerWorkspace(protocols, manifestDefinitions)
registerProfileProtocols(protocols)
registerTuiContributionExtensions(manifestDefinitions)

function resolveProfileReference(reference) {
  const exact = byCoordinate.get(coordinateKey(reference))
  if (exact !== undefined) return { entry: exact, unknownVersion: false }
  const family = byFamily.get(familyKey(reference))
  if (family !== undefined) return { entry: family, unknownVersion: true }
  throw new Error('protocol definition is not admitted by this profile: ' + coordinateKey(reference))
}

function resolveSubscription(subscription) {
  const entry = typeof subscription === 'string'
    ? byName.get(subscription)
    : byCoordinate.get(coordinateKey(subscription))
  if (entry === undefined) throw new Error('unknown subscription: ' + (typeof subscription === 'string' ? subscription : coordinateKey(subscription)))
  if (entry.kind !== 'event') throw new Error('subscription must reference an event: ' + (entry.name ?? coordinateKey(entry.coordinates)))
  return entry
}

const results = []
function check(label, fn) {
  try {
    const detail = fn()
    results.push({ label, pass: true })
    console.log('✓ ' + label + (detail ? ' — ' + detail : ''))
  } catch (error) {
    results.push({ label, pass: false, error: error instanceof Error ? error.message : String(error) })
    console.error('✗ ' + label + ': ' + results.at(-1).error)
  }
}

const manifestPath = path.join(pluginRoot, 'dsh-plugin.json')
const manifestSource = fs.readFileSync(manifestPath, 'utf8')
let parsed

// ── TUI-PKG-001：Community v0.15 解析（固定 revision 的 @dsh-std/manifest） ──
check('TUI-PKG-001 dsh-plugin.json 通过 @dsh-std/manifest Community v0.15 parse', () => {
  parsed = parseManifest(manifestSource, { source: 'dsh-plugin.json' })
  if (!facetApiVersions.includes(parsed.facets.host.apiVersion)) {
    throw new Error('facet apiVersion is not admitted: ' + parsed.facets.host.apiVersion)
  }
  return 'id=' + parsed.id + ' version=' + parsed.version + ' facet=' + parsed.facets.host.apiVersion
})

// ── TUI-PKG-002：声明闭环 ──
check('TUI-PKG-002 协议坐标全部可被 profile 解析，optional 均有 fallback', () => {
  for (const requirement of parsed.requires.contracts) {
    const resolved = resolveProfileReference(requirement)
    if (resolved.unknownVersion) throw new Error('unknown version: ' + coordinateKey(requirement))
    if (requirement.optional === true && !requirement.fallback) {
      throw new Error('optional protocol requires a TUI fallback: ' + coordinateKey(requirement))
    }
  }
  for (const subscription of parsed.subscriptions) resolveSubscription(subscription)
  return 'contracts=' + parsed.requires.contracts.length + ' subscriptions=' + parsed.subscriptions.length
})

check('TUI-PKG-002 Manifest 投影 + 扩展贡献校验（Command / x-dsh-tui Scene）', () => {
  const projected = projectManifest(parsed)
  const report = manifestDefinitions.validate(projected, protocols, { source: 'dsh-plugin.json' })
  const errors = report.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map(issue => issue.message).join('; '))
  const extensions = projected.spec.facets[0].extensions ?? []
  return 'extensions=' + extensions.map(row => row.kind + ':' + row.metadata.name).join(', ')
})

// ── 运行时一致性：清单声明的命令/场景 identity 与代码注册一致 ──
check('清单 identity 与运行时代码一致（/music 命令 + music-player 场景）', () => {
  const entry = fs.readFileSync(path.join(pluginRoot, parsed.facets.host.entry), 'utf8')
  const command = parsed.contributes.commands[0]
  const localName = command.id.split('.').at(-1)
  if (!entry.includes("name: '" + localName + "'")) throw new Error('入口未注册命令 ' + localName)
  const scene = (parsed.contributes['x-dsh-tui'] ?? []).find(row => row.kind === 'Scene')
  if (scene === undefined) throw new Error('缺少 Scene 贡献')
  if (!entry.includes("id: '" + scene.name + "'")) throw new Error('入口未注册场景 ' + scene.name)
  return 'command=/' + localName + ' scene=' + scene.name
})

// ── TUI-HOST-001：对规范示例 host 跑 admission decision ──
function admissionDecision(host, grants = []) {
  const supportKeys = new Set(host.contracts.map(coordinateKey))
  const unknown = parsed.requires.contracts.filter(requirement => {
    try { return resolveProfileReference(requirement).unknownVersion } catch { return false }
  })
  if (unknown.length > 0) return { decision: 'unknown', reasonCode: 'UNKNOWN_PROTOCOL_VERSION' }
  if (!host.facetApiVersions.includes(parsed.facets.host.apiVersion)) {
    return { decision: 'rejected', reasonCode: 'FACET_API_VERSION_UNAVAILABLE' }
  }
  const projected = projectManifest(parsed)
  const requirements = projected.spec.facets[0].protocols?.requires ?? []
  const missingRequired = requirements.filter(row => row.optional !== true && !supportKeys.has(coordinateKey(row)))
  const missingOptional = requirements.filter(row => row.optional === true && !supportKeys.has(coordinateKey(row)))
  if (missingRequired.length > 0) return { decision: 'rejected', reasonCode: 'REQUIRED_PROTOCOL_UNAVAILABLE', missingRequired: missingRequired.map(coordinateKey) }
  const declaration = defineProtocolDeclaration({ participant: { id: parsed.id }, requires: requirements })
  const hostDeclaration = defineProtocolDeclaration({
    participant: { id: host.hostId },
    supports: host.contracts.map(contract => ({ apiVersion: contract.apiVersion, kind: contract.kind, ...(contract.spec === undefined ? {} : { spec: contract.spec }) })),
  })
  const report = protocols.negotiate([declaration, hostDeclaration])
  if (!report.compatible && missingOptional.length === 0) return { decision: 'rejected', reasonCode: 'PROTOCOL_NEGOTIATION_FAILED', issues: report.issues }
  const hostPermissions = new Set(host.contracts.flatMap(contract => contract.permissions))
  const granted = new Set(grants)
  const denied = parsed.permissions.filter(request => {
    if (!hostPermissions.has(request.name)) return true
    const definition = permissionRegistry.permissions.find(permission => permission.name === request.name)
    return definition === undefined || (definition.default === 'deny' && !granted.has(request.name))
  })
  if (denied.length > 0) return { decision: 'waiting_authorization', reasonCode: 'PERMISSION_NOT_GRANTED', deniedPermissions: denied.map(request => request.name) }
  return { decision: missingOptional.length > 0 ? 'compatible_degraded' : 'compatible' }
}

check('TUI-HOST-001 admission decision（dsh-tui 示例 host）', () => {
  const decision = admissionDecision(loadJson('registry/host-descriptor.tui.example.json'))
  if (decision.decision === 'rejected' || decision.decision === 'unknown') throw new Error(JSON.stringify(decision))
  return JSON.stringify(decision)
})

check('TUI-HOST-001 admission decision（minimal host，降级场景）', () => {
  const decision = admissionDecision(loadJson('conformance/fixtures/host-no-observe.example.json'))
  if (decision.decision === 'rejected' || decision.decision === 'unknown') throw new Error(JSON.stringify(decision))
  return JSON.stringify(decision)
})

const failed = results.filter(result => !result.pass)
console.log(failed.length === 0
  ? '\n全部 ' + results.length + ' 项检查通过 —— dsh-plugin.json 符合 dsh-TUI 准入 profile v0.15'
  : '\n' + failed.length + '/' + results.length + ' 项检查失败')
process.exit(failed.length === 0 ? 0 : 1)

