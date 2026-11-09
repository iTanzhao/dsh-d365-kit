/**
 * Client half: the "D365 工具箱" settings page, split into tabs.
 *
 *   Environments  the environment list, secrets, default environment
 *   Permissions   which capabilities are granted to which environment
 *   Pending       plans the agent prepared; the only place they can be executed
 *   General       tool parameters that are not per-environment
 *
 * Data comes from the authenticated `/api/d365-meta/*` routes; the environment
 * list is the same storage the `d365_configure` tool writes, so the page can
 * never drift from what the agent reads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-d365-kit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Header every route that can change an environment expects.
     *
     * The `/api` channel strips `Origin`, so this header is what proves the
     * request came from this page: another site cannot send it without a CORS
     * preflight, which these routes never answer.
     */
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-d365-meta-write': '1' }

    const DICT = {
      en: {
        'section.title': 'D365 Toolkit',
        'section.desc': 'Connect Dataverse environments, manage read/write permissions and pending changes, review local data and check results.',
        'tab.environments': 'Environments',
        'tab.permissions': 'Permissions',
        'tab.plans': 'Pending changes',
        'tab.data': 'Data',
        'tab.general': 'General',
        'data.title': 'Local data',
        'data.desc': 'Snapshots, reports and query artifacts are stored on this machine. This page shows what is using space and applies the retention policy.',
        'data.total': 'Total',
        'data.class': 'Class',
        'data.count': 'Files',
        'data.size': 'Size',
        'data.policy': 'Retention',
        'data.keepPolicy': 'keep {keep} / {days} days',
        'data.overLimit': 'over {mb} MB — consider cleaning up',
        'data.cleanup': 'Preview cleanup',
        'data.compact': 'Compact snapshots',
        'data.plan': 'Will delete {files} files and free {size}.',
        'data.confirm': 'Delete now',
        'data.deleted': 'Deleted {files} files, freed {size}.',
        'data.compacted': 'Compacted {snapshots} snapshots, freed {size}.',
        'data.nothing': 'Nothing to clean up under the current policy.',
        'data.failed': 'Failed: {error}',
        'add': 'Add environment',
        'save': 'Save',
        'saving': 'Saving…',
        'test': 'Test connection',
        'testing': 'Testing…',
        'remove': 'Remove',
        'label': 'Display name',
        'url': 'Environment URL',
        'cloud': 'Cloud',
        'tenantId': 'Tenant ID',
        'clientId': 'Application user ClientId',
        'secret': 'Client secret',
        'secretSaved': 'Secret saved (source: {source})',
        'clear': 'Remove saved secret',
        'secretHint': 'The secret is written to the local d365.secrets.json in plain text, never to d365.config.json. Keep that file out of Git.',
        'default': 'Default environment',
        'saved': 'Saved.',
        'savedSecrets': 'Saved; the secret went to d365.secrets.json.',
        'loadFailed': 'Could not load the configuration: {error}',
        'saveFailed': 'Could not save: {error}',
        'checkOk': 'Connected: {name} ({version})',
        'checkFail': 'Connection failed: {error}',
        'checkMissing': 'Missing credentials: {list}',
        'issues': 'Configuration warnings',
        'files': 'Config: {config}',
        'secretFile': 'Secrets: {secrets}',
        'empty': 'No environments yet. Start with "Add environment".',
        'urlRequired': 'Fill in the URL for "{key}" first.',
        'duplicate': 'Duplicate key: {key}',
        'existing': 'already saved',
        'keyHint': 'Short key the tools use, e.g. dev.',
        'write.title': 'Write permissions',
        'write.desc': 'Choose what this machine may do in each environment. Metadata reads are on by default; business records need "Read business data". Metadata changes need a capability here and still require a confirm click.',
        'write.gate': 'Every request is checked against the target environment\'s grants below before it leaves this machine; a tool cannot skip the check.',
        'write.envSummary': '{granted} of {total} granted',
        'write.envNote': 'Metadata (tables, fields, forms, views, plugins, solution layers) needs "Read metadata", ticked by default. Untick everything to block even metadata. Business records need "Read business data"; a write also needs its capability here plus a confirm click in the chat.',
        'write.noEnvironments': 'Add an environment first.',
        'write.solution': 'Default solution for changes',
        'write.solutionHint': 'Solution unique name, so exported solutions carry the change',
        'write.savePolicy': 'Save permissions',
        'write.copyToAll': 'Copy to all environments',
        'write.copied': 'Copied into the other environments — review, then save.',
        'write.savedPolicy': 'Permissions saved.',
        'write.saveFailed': 'Could not save: {error}',
        'write.plans': 'Pending changes',
        'write.plansDesc': 'Plans prepared by the agent. Nothing runs until you confirm here or in the chat.',
        'write.noPlans': 'No pending changes. The agent can prepare one with d365_write.',
        'write.execute': 'Review & execute',
        'write.confirmExecute': 'Execute now',
        'write.executing': 'Executing…',
        'write.back': 'Cancel',
        'write.cancelPlan': 'Discard plan',
        'write.warningTitle': 'This writes to a real environment',
        'write.warningBody': 'The following operations will run against {env} immediately. Dataverse metadata changes cannot be rolled back automatically.',
        'write.destructiveBody': 'This includes a deletion that cannot be undone: the column or option value is removed permanently. Check the names before confirming.',
        'write.highRisk': 'destructive',
        'write.executed': 'Done: {ok} succeeded, {failed} failed.',
        'write.skipped': '{count} entries skipped (already present or unchanged).',
        'write.publishing': ' Publishing in the background; the change becomes visible shortly.',
        'write.recent': 'Recent changes',
        'write.recentLine': '{time} · {env} · {ok} ok / {failed} failed',
        'plans.more': '… {count} more',
        'write.publishRunning': 'publishing…',
        'write.published': 'published',
        'write.publishFailed': 'publish failed: {error}',
        'write.publishSkipped': 'nothing to publish',
        'write.republish': 'Publish again',
        'write.republishing': 'Publishing…',
        'write.republishOk': 'Published: {targets}',
        'write.republishFailed': 'Publish failed: {error}',
        'write.noTargets': 'nothing to publish',
        'write.optionSetLabel': 'option set {name}',
        'write.loadFailed': 'Could not load write settings: {error}',
        'general.title': 'Tool parameters',
        'general.desc': 'Numbers the tools use by default. They are stored in d365.config.json next to the environment list.',
        'general.snapshotKeep': 'Snapshots kept per environment',
        'general.snapshotKeepHint': 'Older snapshots are deleted after a sync. 1–50.',
        'general.maxRecords': 'Default row limit',
        'general.maxRecordsHint': 'Used when a tool call passes no value of its own. 1–100000.',
        'general.timeoutMs': 'Request timeout (ms)',
        'general.timeoutMsHint': 'Per HTTP request. 5000–300000.',
        'general.dataDir': 'Local data directory',
        'general.dataDirHint': 'Snapshots, diffs, pending writes and change records live here.',
        'general.save': 'Save parameters',
        'general.saved': 'Parameters saved.',
        'general.loadFailed': 'Could not load parameters: {error}',
        'tab.gitlab': 'GitLab',
        'gitlab.title': 'GitLab',
        'gitlab.desc': 'Used by d365_code_check to read a merge request and check its changed scripts against the environments. Read-only access is enough.',
        'gitlab.url': 'GitLab base URL',
        'gitlab.urlHint': 'For example https://gitlab.example.com — the page stays the same for every project.',
        'gitlab.project': 'Default project',
        'gitlab.projectHint': 'group/project. Used when the merge request link does not carry one.',
        'gitlab.token': 'Access token',
        'gitlab.tokenHint': 'A personal or project token with read_api. Saved to d365.secrets.json, never to d365.config.json.',
        'gitlab.tokenSaved': 'A token is already saved ({source}). Leave empty to keep it.',
        'gitlab.save': 'Save',
        'gitlab.saved': 'Saved.',
        'gitlab.check': 'Test access',
        'gitlab.checking': 'Testing…',
        'gitlab.ok': 'Connected as {user}.',
        'gitlab.clear': 'Remove token',
        'gitlab.cleared': 'Token removed.',
        'gitlab.loadFailed': 'Could not load GitLab settings: {error}',
      },
      zh: {
        'section.title': 'D365 工具箱',
        'section.desc': '接入 Dataverse 环境，管理读写权限与待确认变更，查看本机数据与检查结果。',
        'tab.environments': '环境',
        'tab.permissions': '权限',
        'tab.plans': '计划',
        'tab.data': '数据',
        'tab.general': '常规',
        'data.title': '本机数据',
        'data.desc': '快照、报告与查询留证都存在本机。这里显示占用情况，并按保留策略清理。',
        'data.total': '合计',
        'data.class': '类别',
        'data.count': '文件',
        'data.size': '占用',
        'data.policy': '保留策略',
        'data.keepPolicy': '保留 {keep} 个 / {days} 天',
        'data.overLimit': '超过 {mb} MB，建议清理',
        'data.cleanup': '预演清理',
        'data.compact': '压缩快照',
        'data.plan': '将删除 {files} 个文件，释放 {size}。',
        'data.confirm': '确认删除',
        'data.deleted': '已删除 {files} 个文件，释放 {size}。',
        'data.compacted': '已压缩 {snapshots} 份快照，释放 {size}。',
        'data.nothing': '按当前策略没有需要清理的内容。',
        'data.failed': '操作失败：{error}',
        'add': '添加环境',
        'save': '保存',
        'saving': '保存中…',
        'test': '测试连接',
        'testing': '测试中…',
        'remove': '删除',
        'label': '显示名',
        'url': '环境 URL',
        'cloud': '云',
        'tenantId': '租户 ID',
        'clientId': '应用用户 ClientId',
        'secret': '客户端密钥',
        'secretSaved': '密钥已保存（来源：{source}）',
        'clear': '清除已保存的密钥',
        'secretHint': '密钥以明文写入本机 d365.secrets.json，不会写进 d365.config.json；别把它提交到 Git。',
        'default': '默认环境',
        'saved': '已保存。',
        'savedSecrets': '已保存，密钥写入了 d365.secrets.json。',
        'loadFailed': '读取配置失败：{error}',
        'saveFailed': '保存失败：{error}',
        'checkOk': '连接正常：{name}（{version}）',
        'checkFail': '连接失败：{error}',
        'checkMissing': '缺少凭据：{list}',
        'issues': '配置告警',
        'files': '配置文件：{config}',
        'secretFile': '密钥文件：{secrets}',
        'empty': '还没有环境，点"添加环境"开始。',
        'urlRequired': '请先填写 "{key}" 的 URL。',
        'duplicate': 'key 重复：{key}',
        'existing': '已保存',
        'keyHint': '工具里用的短名，例如 dev。',
        'write.title': '权限',
        'write.desc': '选择这台机器可以对哪些环境做什么。元数据默认可读；读取业务数据需要勾「读取业务数据」；元数据修改需要先在这里授权，执行前仍要确认。',
        'write.gate': '每一次访问在发出前都会按目标环境核对下面的勾选，任何工具都绕不过这道检查。',
        'write.envSummary': '已授权 {granted}/{total}',
        'write.envNote': '元数据（表、字段、表单、视图、插件、解决方案层）归「读取元数据」管，默认勾上；全部取消就什么都查不到。业务记录需要勾「读取业务数据」；写操作除勾选外，还要在对话里点确认。',
        'write.noEnvironments': '请先添加环境。',
        'write.solution': '变更默认解决方案',
        'write.solutionHint': '解决方案唯一名：填了，导出的解决方案才会带上这次改动',
        'write.savePolicy': '保存权限',
        'write.copyToAll': '复制到其他环境',
        'write.copied': '已复制到其他环境，核对后再保存。',
        'write.savedPolicy': '权限已保存。',
        'write.saveFailed': '保存失败：{error}',
        'write.plans': '待确认的写入',
        'write.plansDesc': 'agent 准备好的计划。在你确认之前，什么都不会执行。',
        'write.noPlans': '没有待确认的变更。可以让 agent 用 d365_write 生成一个计划。',
        'write.execute': '审阅并执行',
        'write.confirmExecute': '确认执行',
        'write.executing': '执行中…',
        'write.back': '返回',
        'write.cancelPlan': '丢弃计划',
        'write.warningTitle': '这是对真实环境的写入',
        'write.warningBody': '以下操作会立即作用到 {env}。Dataverse 的元数据变更无法自动回滚，请先核对操作列表。',
        'write.destructiveBody': '其中包含不可恢复的删除操作：被删的字段或选项值连同其数据一起消失，无法通过重新部署找回。确认前请核对名称。',
        'write.highRisk': '高危',
        'write.executed': '执行完成：成功 {ok} 个，失败 {failed} 个。',
        'write.skipped': '跳过 {count} 条（已存在或无变化）。',
        'write.publishing': '正在后台发布，稍后生效。',
        'write.recent': '最近的变更记录',
        'write.recentLine': '{time} · {env} · 成功 {ok} / 失败 {failed}',
        'plans.more': '… 其余 {count} 个',
        'write.publishRunning': '发布中…',
        'write.published': '已发布',
        'write.publishFailed': '发布失败：{error}',
        'write.publishSkipped': '无需发布',
        'write.republish': '重新发布',
        'write.republishing': '发布中…',
        'write.republishOk': '已发布：{targets}',
        'write.republishFailed': '发布失败：{error}',
        'write.noTargets': '无需发布',
        'write.optionSetLabel': '选项集 {name}',
        'write.loadFailed': '读取写入配置失败：{error}',
        'general.title': '工具参数',
        'general.desc': '工具默认使用的数值，和环境清单一起存在 d365.config.json 里。',
        'general.snapshotKeep': '每个环境保留几份快照',
        'general.snapshotKeepHint': '同步后删除更旧的快照。范围 1–50。',
        'general.maxRecords': '单次返回行数上限',
        'general.maxRecordsHint': '仅在工具调用自己没传值时生效。范围 1–100000。',
        'general.timeoutMs': '请求超时（毫秒）',
        'general.timeoutMsHint': '单个 HTTP 请求的超时。范围 5000–300000。',
        'general.dataDir': '本地数据目录',
        'general.dataDirHint': '快照、差异、待确认计划、变更记录都在这里。',
        'general.save': '保存参数',
        'general.saved': '参数已保存。',
        'general.loadFailed': '读取参数失败：{error}',
        'tab.gitlab': 'GitLab',
        'gitlab.title': 'GitLab',
        'gitlab.desc': '供 d365_code_check 读取 MR、把改动的脚本对照环境做检查。只需要只读权限。',
        'gitlab.url': 'GitLab 地址',
        'gitlab.urlHint': '例如 https://gitlab.example.com，各项目共用同一个页面地址。',
        'gitlab.project': '默认项目',
        'gitlab.projectHint': 'group/project。MR 链接里带项目时以链接为准。',
        'gitlab.token': '访问令牌',
        'gitlab.tokenHint': '勾了 read_api 的个人令牌或项目令牌。存在 d365.secrets.json，不会写进 d365.config.json。',
        'gitlab.tokenSaved': '已有令牌（来源：{source}），留空表示不修改。',
        'gitlab.save': '保存',
        'gitlab.saved': '已保存。',
        'gitlab.check': '测试访问',
        'gitlab.checking': '测试中…',
        'gitlab.ok': '连接正常，当前用户 {user}。',
        'gitlab.clear': '删除令牌',
        'gitlab.cleared': '令牌已删除。',
        'gitlab.loadFailed': '读取 GitLab 设置失败：{error}',
      },
    }

    /**
     * The page translates from its own dictionary; the locale service only says
     * *which* language is active. Using the service's lookup directly would turn
     * one failed registration into a page of raw keys.
     */
    let activeLocale = 'en'
    let localeService = null
    const localeListeners = new Set()

    /** Re-render every mounted panel (locale service arrival or language switch). */
    function notifyLocale() {
      for (const listener of [...localeListeners]) {
        try {
          listener()
        } catch {
          // One crashed panel must not stop the others from re-rendering.
        }
      }
    }

    function localeFrom(id) {
      return String(id ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** Active locale id from either read entry the service exposes. */
    function activeIdOf(locale) {
      try {
        const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.()
        return snapshot?.active
      } catch {
        return undefined
      }
    }

    /** Read the live locale on every call: the page must follow DSH's setting. */
    function currentLocale() {
      const live = activeIdOf(localeService)
      if (live) return localeFrom(live)
      return activeLocale
    }

    function t(key, params) {
      const text = DICT[currentLocale()]?.[key] ?? DICT.en[key] ?? key
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (params[name] ?? match))
    }

    /** Re-render a panel when the locale service arrives or the language changes. */
    function useLocaleRevision() {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setRevision((value) => value + 1)
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      }, [])
    }

    const T = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: '6px',
      border: `1px solid ${T.border}`,
      background: T.bg2,
      color: T.text,
      font: 'inherit',
      fontSize: '13px',
      outline: 'none',
    }

    const labelStyle = {
      display: 'block',
      fontSize: '12px',
      color: T.muted,
      marginBottom: '4px',
    }

    function buttonStyle(kind) {
      const base = {
        padding: '6px 12px',
        borderRadius: '6px',
        fontSize: '13px',
        font: 'inherit',
        cursor: 'pointer',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.text,
        whiteSpace: 'nowrap',
      }
      if (kind === 'primary') return { ...base, background: T.brand, borderColor: T.brand, color: '#fff' }
      if (kind === 'danger') return { ...base, color: T.error, borderColor: 'transparent', padding: '6px 8px' }
      return base
    }

    const thStyle = {
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: `1px solid ${T.border}`,
      color: T.muted,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }

    const tdStyle = {
      padding: '6px 8px',
      borderBottom: `1px solid ${T.border}`,
      verticalAlign: 'top',
      color: T.text,
    }

    /** Human-readable byte size, matching the Host's retention formatter. */
    function formatBytesUi(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'block', minWidth: 0 } },
        h('span', { style: labelStyle }, label),
        children,
        hint ? h('span', { style: { display: 'block', marginTop: '3px', fontSize: '11px', color: T.muted } }, hint) : null,
      )
    }

    function Hint({ children, kind }) {
      const color = kind === 'error' ? T.error : kind === 'ok' ? T.success : T.muted
      return h('div', { style: { fontSize: '12px', color, lineHeight: 1.5 } }, children)
    }

    /**
     * Row identity for React. It must not derive from the editable key: a card
     * keyed by its own value is a new element on every keystroke, which unmounts
     * the input and drops the caret after one character.
     */
    let draftSeq = 0
    function nextDraftId() {
      draftSeq += 1
      return `draft-${draftSeq}`
    }

    function toDraft(env) {
      return {
        id: `env-${env.key}`,
        key: env.key,
        label: env.label ?? '',
        url: env.url ?? '',
        cloud: env.cloud ?? 'public',
        tenantId: env.tenantId ?? '',
        clientId: env.clientId ?? '',
        clientSecret: '',
        clearSecret: false,
        hasSecret: Boolean(env.hasSecret),
        secretSource: env.secretSource,
        existing: true,
      }
    }

    // ---------------------------------------------------------------- environments

    function EnvironmentsPanel() {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [rows, setRows] = React.useState([])
      const [defaultKey, setDefaultKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [checks, setChecks] = React.useState({})

      const applySettings = React.useCallback((next) => {
        setSettings(next)
        setRows((next.environments ?? []).map(toDraft))
        setDefaultKey(next.defaultEnvironment ?? '')
      }, [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch('/api/d365-meta/config', { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
            if (!alive) return
            applySettings(data.settings)
            setError(null)
          } catch (cause) {
            if (alive) setError(cause.message)
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [applySettings])

      const update = (index, patch) => {
        setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      }

      const addRow = () => {
        let n = 1
        while (rows.some((row) => row.key === `env${n}`)) n += 1
        setRows((current) => [...current, {
          id: nextDraftId(),
          key: `env${n}`,
          label: '',
          url: '',
          cloud: 'public',
          tenantId: '',
          clientId: '',
          clientSecret: '',
          clearSecret: false,
          hasSecret: false,
          existing: false,
        }])
      }

      const removeRow = (index) => {
        setRows((current) => current.filter((_, i) => i !== index))
      }

      const save = async () => {
        const keys = new Set()
        for (const row of rows) {
          if (!row.url.trim()) {
            setMessage({ kind: 'error', text: t('urlRequired', { key: row.key }) })
            return
          }
          if (keys.has(row.key)) {
            setMessage({ kind: 'error', text: t('duplicate', { key: row.key }) })
            return
          }
          keys.add(row.key)
        }

        const environments = {}
        for (const row of rows) {
          environments[row.key] = {
            label: row.label,
            url: row.url,
            cloud: row.cloud,
            tenantId: row.tenantId,
            clientId: row.clientId,
            clientSecret: row.clientSecret || undefined,
            clearSecret: row.clearSecret || undefined,
          }
        }

        setBusy(true)
        setMessage(null)
        try {
          const response = await fetch('/api/d365-meta/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ defaultEnvironment: defaultKey, environments }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          applySettings(data.settings)
          setChecks({})
          setMessage({ kind: 'ok', text: data.secretsTouched?.length ? t('savedSecrets') : t('saved') })
        } catch (cause) {
          setMessage({ kind: 'error', text: t('saveFailed', { error: cause.message }) })
        } finally {
          setBusy(false)
        }
      }

      const test = async (row) => {
        setChecks((current) => ({ ...current, [row.key]: { status: 'pending' } }))
        try {
          const response = await fetch('/api/d365-meta/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: row.key }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          if (data.ok) {
            const org = data.organization ?? {}
            setChecks((current) => ({
              ...current,
              [row.key]: { status: 'ok', text: t('checkOk', { name: org.name ?? '—', version: org.version ?? '?' }) },
            }))
            return
          }
          const missing = data.missing?.length
            ? ` ${t('checkMissing', { list: data.missing.map((item) => item.kind).join(' / ') })}`
            : ''
          setChecks((current) => ({
            ...current,
            [row.key]: { status: 'fail', text: `${t('checkFail', { error: data.error ?? '?' })}${missing}` },
          }))
        } catch (cause) {
          setChecks((current) => ({ ...current, [row.key]: { status: 'fail', text: t('checkFail', { error: cause.message }) } }))
        }
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('loadFailed', { error }))

      const cards = rows.map((row, index) => {
        const check = checks[row.key]
        return h('div', {
          key: row.id,
          style: {
            border: `1px solid ${T.border}`,
            borderRadius: '8px',
            background: T.bg,
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          },
        },
        // One row, equal column shapes: every cell is a label plus exactly one
        // control of the same height, so the labels and the controls line up.
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          h('div', { style: { flex: '0 0 116px', minWidth: '116px' } },
            h(Field, { label: 'key' },
              row.existing
                ? h('input', {
                  style: { ...inputStyle, background: 'transparent', fontWeight: 600 },
                  value: row.key,
                  readOnly: true,
                })
                : h('input', {
                  style: inputStyle,
                  value: row.key,
                  placeholder: 'dev',
                  spellCheck: false,
                  onChange: (event) => update(index, { key: event.target.value.trim() }),
                }),
            ),
          ),
          h('div', { style: { flex: '1 1 150px', minWidth: 0 } },
            h(Field, { label: t('label') },
              h('input', {
                style: inputStyle,
                value: row.label,
                placeholder: row.key,
                onChange: (event) => update(index, { label: event.target.value }),
              }),
            ),
          ),
          h('div', { style: { flex: '0 0 118px' } },
            h(Field, { label: t('cloud') },
              h('select', {
                style: inputStyle,
                value: row.cloud,
                onChange: (event) => update(index, { cloud: event.target.value }),
              },
              (settings?.clouds ?? ['public']).map((cloud) => h('option', { key: cloud, value: cloud }, cloud)),
              ),
            ),
          ),
          h('button', {
            type: 'button',
            style: { ...buttonStyle('danger'), marginLeft: 'auto' },
            onClick: () => removeRow(index),
          }, t('remove')),
        ),
        h(Field, { label: t('url') },
          h('input', {
            style: inputStyle,
            value: row.url,
            placeholder: 'https://contoso-dev.crm5.dynamics.com',
            spellCheck: false,
            onChange: (event) => update(index, { url: event.target.value }),
          }),
        ),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('div', { style: { flex: '1 1 50%', minWidth: 0 } },
            h(Field, { label: t('tenantId') },
              h('input', {
                style: inputStyle,
                value: row.tenantId,
                placeholder: '00000000-0000-0000-0000-000000000000',
                spellCheck: false,
                onChange: (event) => update(index, { tenantId: event.target.value }),
              }),
            ),
          ),
          h('div', { style: { flex: '1 1 50%', minWidth: 0 } },
            h(Field, { label: t('clientId') },
              h('input', {
                style: inputStyle,
                value: row.clientId,
                placeholder: '00000000-0000-0000-0000-000000000000',
                spellCheck: false,
                onChange: (event) => update(index, { clientId: event.target.value }),
              }),
            ),
          ),
        ),
        h(Field, {
          label: t('secret'),
          hint: row.hasSecret ? t('secretSaved', { source: row.secretSource ?? 'secrets' }) : t('secretHint'),
        },
        h('input', {
          style: inputStyle,
          type: 'password',
          value: row.clientSecret,
          placeholder: row.hasSecret ? '••••••••' : '',
          autoComplete: 'new-password',
          onChange: (event) => update(index, { clientSecret: event.target.value, clearSecret: false }),
        }),
        ),
        row.hasSecret
          ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: T.muted } },
            h('input', {
              type: 'checkbox',
              checked: row.clearSecret,
              onChange: (event) => update(index, { clearSecret: event.target.checked, clientSecret: '' }),
            }),
            t('clear'),
          )
          : null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: buttonStyle(),
            disabled: check?.status === 'pending' || !row.existing,
            onClick: () => test(row),
          }, check?.status === 'pending' ? t('testing') : t('test')),
          check?.status === 'ok' ? h('span', { style: { fontSize: '12px', color: T.success } }, check.text) : null,
          check?.status === 'fail' ? h('span', { style: { fontSize: '12px', color: T.error } }, check.text) : null,
        ),
        )
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        settings?.issues?.length
          ? h('div', {
            style: {
              border: `1px solid ${T.warn}`,
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '12px',
              color: T.text,
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            },
          },
          h('strong', { style: { fontWeight: 600 } }, t('issues')),
          settings.issues.map((issue, index) => h('div', { key: index, style: { color: T.muted } }, issue)),
          )
          : null,

        cards.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, cards)
          : h(Hint, null, t('empty')),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle(), onClick: addRow }, t('add')),
          rows.length
            ? h('div', { style: { flex: '0 0 200px' } },
              h(Field, { label: t('default') },
                h('select', {
                  style: inputStyle,
                  value: defaultKey,
                  onChange: (event) => setDefaultKey(event.target.value),
                },
                rows.map((row) => h('option', { key: row.key, value: row.key }, row.key)),
                ),
              ),
            )
            : null,
          h('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: save,
          }, busy ? t('saving') : t('save')),
        ),

        message ? h(Hint, { kind: message.kind }, message.text) : null,

        h('div', { style: { fontSize: '11px', color: T.muted, lineHeight: 1.6 } },
          settings?.configFile ? h('div', null, t('files', { config: settings.configFile })) : null,
          settings?.secretsFile ? h('div', null, t('secretFile', { secrets: settings.secretsFile })) : null,
        ),
      )
    }

    // ---------------------------------------------------------------- permissions

    function PermissionsPanel() {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [capabilities, setCapabilities] = React.useState({})
      const [environments, setEnvironments] = React.useState([])
      const [draft, setDraft] = React.useState({})
      const [solution, setSolution] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [copySource, setCopySource] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/api/d365-meta/write/policy')
          const policy = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(policy.error ?? `HTTP ${response.status}`)

          const nextDraft = {}
          for (const key of policy.environments ?? []) {
            // An environment with no entry has never been configured: it keeps
            // the default metadata read. An entry, even an empty one, is the
            // whole truth.
            const explicit = policy.policy?.environments?.[key]
            const granted = Array.isArray(explicit) ? explicit : null
            nextDraft[key] = Object.fromEntries(
              Object.keys(policy.capabilities ?? {}).map((capability) => [
                capability,
                granted ? granted.includes(capability) : capability === 'metadata.read',
              ]),
            )
          }
          setCapabilities(policy.capabilities ?? {})
          setEnvironments(policy.environments ?? [])
          setDraft(nextDraft)
          setSolution(policy.policy?.solutionHint ?? '')
          setCopySource((current) => current || (policy.environments ?? [])[0] || '')
          setError(null)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const toggle = (envKey, capability) => {
        setDraft((current) => ({
          ...current,
          [envKey]: { ...(current[envKey] ?? {}), [capability]: !current[envKey]?.[capability] },
        }))
      }

      const savePolicy = async () => {
        setSaving(true)
        setMessage(null)
        try {
          const payload = { environments: {}, solutionUniqueName: solution.trim() || undefined }
          for (const [envKey, values] of Object.entries(draft)) {
            const granted = Object.entries(values).filter(([, on]) => on).map(([capability]) => capability)
            if (granted.length) payload.environments[envKey] = granted
          }
          const response = await fetch('/api/d365-meta/write/policy', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify(payload),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          setMessage({ kind: 'ok', text: t('write.savedPolicy') })
        } catch (cause) {
          setMessage({ kind: 'error', text: t('write.saveFailed', { error: cause.message }) })
        } finally {
          setSaving(false)
        }
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('write.loadFailed', { error }))

      // Grouping is server-driven: a capability may be added without a client change.
      const groups = {}
      for (const [capability, meta] of Object.entries(capabilities)) {
        const group = meta.group ?? ''
        groups[group] = groups[group] ?? []
        groups[group].push([capability, meta])
      }

      const totalCapabilities = Object.keys(capabilities).length

      // Permissions are per-environment, so each environment gets its own
      // block, separated by a rule: a single wide table made one environment's
      // row run into the next.
      const environmentBlocks = environments.map((envKey, index) => {
        const granted = Object.values(draft[envKey] ?? {}).filter(Boolean).length
        return h('div', {
          key: envKey,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            paddingTop: index === 0 ? 0 : '16px',
            borderTop: index === 0 ? 'none' : `1px solid ${T.border}`,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600, color: T.text } }, envKey),
          h('span', { style: { fontSize: '11px', color: T.muted } }, t('write.envSummary', { granted, total: totalCapabilities })),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          Object.entries(groups).map(([group, entries]) => h('div', {
            key: group || '-',
            style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
          },
          group ? h('span', { style: { fontSize: '11px', color: T.muted, minWidth: '48px' } }, group) : null,
          entries.map(([capability, meta]) => h('label', {
            key: capability,
            style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: T.muted },
            title: meta.description,
          },
          h('input', {
            type: 'checkbox',
            checked: Boolean(draft[envKey]?.[capability]),
            onChange: () => toggle(envKey, capability),
          }),
          meta.label,
          meta.risk === 'high' ? h('span', { style: { color: T.error } }, t('write.highRisk')) : null,
          )),
        )),
        ),
        )
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: '14px', color: T.text } }, t('write.title')),
          h('p', { style: { margin: '4px 0 0', fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('write.desc')),
          h('p', { style: { margin: '4px 0 0', fontSize: '11px', color: T.muted, lineHeight: 1.6 } }, t('write.gate')),
          h('p', { style: { margin: '2px 0 0', fontSize: '11px', color: T.muted, lineHeight: 1.6 } }, t('write.envNote')),
        ),

        environmentBlocks.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } }, environmentBlocks)
          : h(Hint, null, t('write.noEnvironments')),

        h('div', { style: { maxWidth: '420px' } },
          h(Field, { label: t('write.solution'), hint: t('write.solutionHint') },
            h('input', {
              style: inputStyle,
              value: solution,
              onChange: (event) => setSolution(event.target.value),
            }),
          ),
        ),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), opacity: saving ? 0.6 : 1 },
            disabled: saving,
            onClick: savePolicy,
          }, saving ? t('saving') : t('write.savePolicy')),
          h('select', {
            style: { ...inputStyle, width: 'auto' },
            value: copySource,
            onChange: (event) => setCopySource(event.target.value),
          }, environments.map((envKey) => h('option', { key: envKey, value: envKey }, envKey))),
          h('button', {
            type: 'button',
            style: buttonStyle('ghost'),
            disabled: !environments.length,
            onClick: () => {
              const source = draft[copySource] ?? {}
              const next = {}
              for (const envKey of environments) next[envKey] = { ...source }
              setDraft(next)
              setMessage({ kind: 'ok', text: t('write.copied') })
            },
          }, t('write.copyToAll')),
        ),

        message ? h(Hint, { kind: message.kind }, message.text) : null,
      )
    }

    // --------------------------------------------------------------------- plans

    /**
     * One line of a plan. Option operations carry their own fields; metadata
     * operations carry a summary built server-side, so new capabilities need no
     * client change to be readable.
     */
    const OPERATION_VERBS = {
      InsertOptionValue: '+',
      CreateAttribute: '+',
      UpdateOptionValue: '~',
      UpdateAttribute: '~',
      UpdateEntity: '~',
      UpdateViewLayout: '~',
      DeleteOptionValue: '!',
      DeleteAttribute: '!',
    }

    function describeOperation(operation) {
      const verb = OPERATION_VERBS[operation.type] ?? '·'
      if (operation.type === 'InsertOptionValue') return `${verb} ${operation.value}  ${operation.label}`
      if (operation.type === 'UpdateOptionValue') {
        return `${verb} ${operation.value}  ${operation.previousLabel ?? ''} → ${operation.label}`
      }
      return `${verb} ${operation.summary ?? operation.type}`
    }

    function PlansPanel({ onCount }) {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [plans, setPlans] = React.useState([])
      const [changes, setChanges] = React.useState([])
      const [publishes, setPublishes] = React.useState({})
      const [message, setMessage] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const [executing, setExecuting] = React.useState(null)
      const [republishing, setRepublishing] = React.useState(null)
      const [polls, setPolls] = React.useState(0)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/api/d365-meta/write/plans')
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          setPlans(data.plans ?? [])
          setChanges(data.changes ?? [])
          setPublishes(data.publishes ?? {})
          setError(null)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      // A publish runs detached, so its outcome appears in the sidecar file
      // later. Poll while something is still in flight, but never forever: a
      // request that died with the Host leaves "running" behind for good.
      const pendingPublish = changes.some((entry) => entry.publishState === 'running' && !publishes[entry.planId])
      React.useEffect(() => {
        if (!pendingPublish || polls >= 40) return undefined
        const timer = setTimeout(() => {
          setPolls((value) => value + 1)
          load()
        }, 3000)
        return () => clearTimeout(timer)
      }, [pendingPublish, polls, load])

      React.useEffect(() => {
        if (!pendingPublish && polls !== 0) setPolls(0)
      }, [pendingPublish, polls])

      React.useEffect(() => {
        onCount?.(plans.length)
      }, [plans.length, onCount])

      const cancelPlan = async (planId) => {
        try {
          const response = await fetch('/api/d365-meta/write/cancel', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ planId }),
          })
          // A 403/404/500 here used to look like success: the list refreshed,
          // the plan was still there, and the person believed it was gone.
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          setConfirming(null)
          await load()
        } catch (cause) {
          setMessage({ kind: 'error', text: String(cause.message) })
        }
      }

      const executePlan = async (planId) => {
        setExecuting(planId)
        setMessage(null)
        try {
          const response = await fetch('/api/d365-meta/write/execute', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ planId }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          const ok = data.results?.length ?? 0
          const failed = data.failures?.length ?? 0
          const publish = data.publishState === 'running' ? t('write.publishing') : ''
          setMessage({ kind: failed ? 'error' : 'ok', text: t('write.executed', { ok, failed }) + publish })
          setConfirming(null)
          await load()
        } catch (cause) {
          setMessage({ kind: 'error', text: cause.message })
        } finally {
          setExecuting(null)
        }
      }

      const republish = async (planId) => {
        setRepublishing(planId)
        setMessage(null)
        try {
          const response = await fetch('/api/d365-meta/write/publish', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ planId }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          const publish = data.publish ?? {}
          setMessage(publish.ok
            ? { kind: 'ok', text: t('write.republishOk', { targets: targetsText(publish.targets) }) }
            : { kind: 'error', text: t('write.republishFailed', { error: publish.error ?? '' }) })
          await load()
        } catch (cause) {
          setMessage({ kind: 'error', text: String(cause.message) })
        } finally {
          setRepublishing(null)
        }
      }

      const targetsText = (scope) => {
        const parts = [...(scope?.entities ?? [])]
        for (const name of scope?.optionSets ?? []) parts.push(t('write.optionSetLabel', { name }))
        return parts.join(' · ')
      }

      const publishStatus = (entry) => {
        const report = publishes[entry.planId]
        if (report && report.ok) return { kind: 'ok', text: t('write.published') }
        if (report && !report.ok) return { kind: 'error', text: t('write.publishFailed', { error: report.error ?? '' }) }
        if (entry.publishState === 'running') return { kind: 'muted', text: t('write.publishRunning') }
        return { kind: 'muted', text: t('write.publishSkipped') }
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('write.loadFailed', { error }))

      const planCards = plans.map((plan) => {
        const isConfirming = confirming === plan.id
        return h('div', {
          key: plan.id,
          style: {
            border: `1px solid ${isConfirming ? T.error : T.border}`,
            borderRadius: '8px',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            background: T.bg,
          },
        },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '13px', color: T.text } }, plan.title ?? plan.kind),
          h('span', { style: { fontSize: '11px', color: T.muted } }, `${plan.envKey} · ${plan.createdAt ?? ''}`),
        ),
        h('div', { style: { fontSize: '12px', color: T.muted, fontFamily: 'ui-monospace, monospace', lineHeight: 1.5, maxHeight: '140px', overflow: 'auto' } },
          (plan.operations ?? []).slice(0, 12).map((operation, index) => h('div', { key: index }, describeOperation(operation))),
          (plan.operations ?? []).length > 12
            ? h('div', null, t('plans.more', { count: plan.operations.length - 12 }))
            : null,
        ),
        (plan.skipped ?? []).length
          ? h('div', { style: { fontSize: '11px', color: T.muted } }, t('write.skipped', { count: plan.skipped.length }))
          : null,

        isConfirming
          ? h('div', {
            style: {
              border: `1px solid ${T.error}`,
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '12px',
              color: T.text,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            },
          },
          h('strong', { style: { color: T.error } }, t('write.warningTitle')),
          h('span', null, t('write.warningBody', { env: plan.envKey })),
          plan.kind === 'attribute.delete' || plan.kind === 'optionValue.delete'
            ? h('span', { style: { color: T.error } }, t('write.destructiveBody'))
            : null,
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button',
              style: { ...buttonStyle('primary'), background: T.error, borderColor: T.error },
              disabled: executing === plan.id,
              onClick: () => executePlan(plan.id),
            }, executing === plan.id ? t('write.executing') : t('write.confirmExecute')),
            h('button', { type: 'button', style: buttonStyle(), onClick: () => setConfirming(null) }, t('write.back')),
          ),
          )
          : h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', {
              type: 'button',
              style: buttonStyle('primary'),
              onClick: () => setConfirming(plan.id),
            }, t('write.execute')),
            h('button', { type: 'button', style: buttonStyle('danger'), onClick: () => cancelPlan(plan.id) }, t('write.cancelPlan')),
          ),
        )
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: '14px', color: T.text } }, t('write.plans')),
          h('p', { style: { margin: '4px 0 0', fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('write.plansDesc')),
        ),

        message ? h(Hint, { kind: message.kind }, message.text) : null,

        planCards.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, planCards)
          : h(Hint, null, t('write.noPlans')),

        changes.length
          ? h('div', { style: { fontSize: '11px', color: T.muted, lineHeight: 1.6, marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', null, t('write.recent')),
            changes.slice(0, 5).map((entry, index) => {
              const status = publishStatus(entry)
              return h('div', {
                key: entry.planId ?? index,
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
              },
              h('span', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                h('span', null, t('write.recentLine', {
                  time: entry.recordedAt ?? '',
                  env: entry.envKey ?? '',
                  ok: entry.applied?.length ?? 0,
                  failed: entry.failed?.length ?? 0,
                })),
                h('span', { style: { color: status.kind === 'error' ? T.error : status.kind === 'ok' ? T.success : T.muted } }, status.text),
              ),
              (entry.applied?.length ?? 0) > 0
                ? h('button', {
                  type: 'button',
                  style: { ...buttonStyle(), fontSize: '11px', padding: '2px 8px' },
                  disabled: republishing === entry.planId,
                  onClick: () => republish(entry.planId),
                }, republishing === entry.planId ? t('write.republishing') : t('write.republish'))
                : null,
              )
            }),
          )
          : null,
      )
    }

    // ------------------------------------------------------------------- general

    const GENERAL_FIELDS = [
      { key: 'snapshotKeep', label: 'general.snapshotKeep', hint: 'general.snapshotKeepHint', min: 1, max: 50 },
      { key: 'maxRecords', label: 'general.maxRecords', hint: 'general.maxRecordsHint', min: 1, max: 100000 },
      { key: 'timeoutMs', label: 'general.timeoutMs', hint: 'general.timeoutMsHint', min: 5000, max: 300000 },
    ]

    function GeneralPanel() {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [general, setGeneral] = React.useState(null)
      const [form, setForm] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch('/api/d365-meta/config', { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
            if (!alive) return
            const next = data.settings?.general ?? {}
            setGeneral(next)
            setForm({
              snapshotKeep: String(next.snapshotKeep ?? ''),
              maxRecords: String(next.maxRecords ?? ''),
              timeoutMs: String(next.timeoutMs ?? ''),
            })
            setError(null)
          } catch (cause) {
            if (alive) setError(cause.message)
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [])

      const save = async () => {
        setBusy(true)
        setMessage(null)
        try {
          const generalPayload = {}
          for (const field of GENERAL_FIELDS) {
            const value = Number(form[field.key])
            if (!Number.isInteger(value) || value < field.min || value > field.max) {
              throw new Error(`${t(field.label)}: ${field.min}–${field.max}`)
            }
            generalPayload[field.key] = value
          }
          const response = await fetch('/api/d365-meta/settings', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ general: generalPayload }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          const next = data.settings?.general ?? general
          setGeneral(next)
          setMessage({ kind: 'ok', text: t('general.saved') })
        } catch (cause) {
          setMessage({ kind: 'error', text: t('write.saveFailed', { error: cause.message }) })
        } finally {
          setBusy(false)
        }
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('general.loadFailed', { error }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: '14px', color: T.text } }, t('general.title')),
          h('p', { style: { margin: '4px 0 0', fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('general.desc')),
        ),

        h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          GENERAL_FIELDS.map((field) => h('div', { key: field.key, style: { flex: '1 1 190px', minWidth: '170px' } },
            h(Field, { label: t(field.label), hint: t(field.hint) },
              h('input', {
                style: inputStyle,
                type: 'number',
                min: field.min,
                max: field.max,
                value: form[field.key] ?? '',
                onChange: (event) => setForm((current) => ({ ...current, [field.key]: event.target.value })),
              }),
            ),
          )),
        ),

        h(Field, { label: t('general.dataDir'), hint: t('general.dataDirHint') },
          h('input', {
            style: { ...inputStyle, background: 'transparent', color: T.muted },
            value: general?.dataDirectory ?? '',
            readOnly: true,
          }),
        ),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: save,
          }, busy ? t('saving') : t('general.save')),
        ),

        message ? h(Hint, { kind: message.kind }, message.text) : null,
      )
    }

    function GitlabPanel() {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [gitlab, setGitlab] = React.useState(null)
      const [form, setForm] = React.useState({ url: '', defaultProject: '', token: '' })
      const [busy, setBusy] = React.useState(false)
      const [checking, setChecking] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch('/api/d365-meta/config', { headers: { accept: 'application/json' } })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
            if (!alive) return
            const next = data.settings?.gitlab ?? {}
            setGitlab(next)
            setForm({
              url: next.url ?? '',
              defaultProject: next.defaultProject ?? '',
              token: '',
            })
            setError(null)
          } catch (cause) {
            if (alive) setError(cause.message)
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [])

      const save = async (extra) => {
        setBusy(true)
        setMessage(null)
        try {
          const payload = {
            url: form.url.trim(),
            defaultProject: form.defaultProject.trim(),
            ...(form.token ? { token: form.token } : {}),
            ...(extra ?? {}),
          }
          const response = await fetch('/api/d365-meta/settings', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ gitlab: payload }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          const next = data.settings?.gitlab ?? gitlab
          setGitlab(next)
          setForm((current) => ({ ...current, token: '' }))
          setMessage({ kind: 'ok', text: extra?.clearToken ? t('gitlab.cleared') : t('gitlab.saved') })
        } catch (cause) {
          setMessage({ kind: 'error', text: t('write.saveFailed', { error: cause.message }) })
        } finally {
          setBusy(false)
        }
      }

      const check = async () => {
        setChecking(true)
        setMessage(null)
        try {
          const response = await fetch('/api/d365-meta/gitlab/check', {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify({ url: form.url.trim() }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          if (!data.ok) throw new Error([data.error, data.hint].filter(Boolean).join(' '))
          setMessage({ kind: 'ok', text: t('gitlab.ok', { user: data.user ?? data.name ?? '' }) })
        } catch (cause) {
          setMessage({ kind: 'error', text: cause.message })
        } finally {
          setChecking(false)
        }
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('gitlab.loadFailed', { error }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: '14px', color: T.text } }, t('gitlab.title')),
          h('p', { style: { margin: '4px 0 0', fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('gitlab.desc')),
        ),

        h(Field, { label: t('gitlab.url'), hint: t('gitlab.urlHint') },
          h('input', {
            style: inputStyle,
            value: form.url,
            placeholder: 'https://gitlab.example.com',
            onChange: (event) => setForm((current) => ({ ...current, url: event.target.value })),
          }),
        ),

        h(Field, { label: t('gitlab.project'), hint: t('gitlab.projectHint') },
          h('input', {
            style: inputStyle,
            value: form.defaultProject,
            placeholder: 'group/project',
            onChange: (event) => setForm((current) => ({ ...current, defaultProject: event.target.value })),
          }),
        ),

        h(Field, {
          label: t('gitlab.token'),
          hint: gitlab?.hasToken && !form.token
            ? t('gitlab.tokenSaved', { source: gitlab.tokenSource ?? '' })
            : t('gitlab.tokenHint'),
        },
          h('input', {
            style: inputStyle,
            type: 'password',
            value: form.token,
            placeholder: gitlab?.hasToken ? '••••••••' : '',
            autoComplete: 'off',
            onChange: (event) => setForm((current) => ({ ...current, token: event.target.value })),
          }),
        ),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: () => save(),
          }, busy ? t('saving') : t('gitlab.save')),
          h('button', {
            type: 'button',
            style: { ...buttonStyle('ghost'), opacity: checking ? 0.6 : 1 },
            disabled: checking,
            onClick: check,
          }, checking ? t('gitlab.checking') : t('gitlab.check')),
          gitlab?.hasToken
            ? h('button', {
              type: 'button',
              style: buttonStyle('ghost'),
              disabled: busy,
              onClick: () => save({ clearToken: true }),
            }, t('gitlab.clear'))
            : null,
        ),

        message ? h(Hint, { kind: message.kind }, message.text) : null,
      )
    }

    function StoragePanel() {
      useLocaleRevision()
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [storage, setStorage] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const load = React.useCallback(async () => {
        const response = await fetch('/api/d365-meta/storage', { headers: { accept: 'application/json' } })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
        return data.storage
      }, [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const next = await load()
            if (alive) {
              setStorage(next)
              setError(null)
            }
          } catch (cause) {
            if (alive) setError(cause.message)
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [load])

      const run = async (path, body) => {
        setBusy(true)
        setMessage(null)
        try {
          const response = await fetch(path, {
            method: 'POST',
            headers: WRITE_HEADERS,
            body: JSON.stringify(body ?? {}),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          if (data.storage) setStorage(data.storage)
          return data
        } catch (cause) {
          setMessage({ kind: 'error', text: t('data.failed', { error: cause.message }) })
          return null
        } finally {
          setBusy(false)
        }
      }

      const preview = async () => {
        const data = await run('/api/d365-meta/storage/cleanup', { dryRun: true, target: 'all' })
        if (!data) return
        setPlan(data.plan)
        if (!data.plan.totalFiles) setMessage({ kind: 'muted', text: t('data.nothing') })
      }

      const remove = async () => {
        const data = await run('/api/d365-meta/storage/cleanup', { dryRun: false, target: 'all' })
        if (!data) return
        setPlan(null)
        setMessage({ kind: 'ok', text: t('data.deleted', { files: data.deleted, size: data.bytesText }) })
      }

      const compact = async () => {
        const data = await run('/api/d365-meta/storage/compact', {})
        if (!data) return
        setMessage({ kind: 'ok', text: t('data.compacted', { snapshots: data.snapshots, size: data.savedText }) })
      }

      if (loading) return h(Hint, null, '…')
      if (error) return h(Hint, { kind: 'error' }, t('general.loadFailed', { error }))
      if (!storage) return null

      const rows = storage.classes ?? []
      const percent = storage.warnMegabytes
        ? Math.min(100, Math.round((storage.totalBytes / (storage.warnMegabytes * 1048576)) * 100))
        : 0

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: '14px', color: T.text } }, t('data.title')),
          h('p', { style: { margin: '4px 0 0', fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('data.desc')),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '13px', color: T.text } }, `${t('data.total')}：${formatBytesUi(storage.totalBytes)}`),
          h('div', { style: { flex: '1 1 200px', minWidth: '160px' } },
            h('div', { style: { height: '6px', borderRadius: '3px', background: T.border, overflow: 'hidden' } },
              h('div', {
                style: {
                  width: `${percent}%`,
                  height: '100%',
                  background: storage.overLimit ? '#d13438' : T.brand,
                },
              }),
            ),
          ),
          storage.overLimit
            ? h('span', { style: { fontSize: '12px', color: '#d13438' } }, t('data.overLimit', { mb: storage.warnMegabytes }))
            : null,
        ),

        h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
            h('thead', null, h('tr', null,
              h('th', { style: thStyle }, t('data.class')),
              h('th', { style: thStyle }, t('data.count')),
              h('th', { style: thStyle }, t('data.size')),
              h('th', { style: thStyle }, t('data.policy')),
            )),
            h('tbody', null, rows.map((row) => h('tr', { key: row.id },
              h('td', { style: tdStyle }, row.label + (row.hint ? ` · ${row.hint}` : '')),
              h('td', { style: tdStyle }, String(row.count)),
              h('td', { style: tdStyle }, formatBytesUi(row.bytes)),
              h('td', { style: tdStyle }, t('data.keepPolicy', { keep: row.keep, days: row.maxAgeDays })),
            ))),
          ),
        ),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: preview,
          }, t('data.cleanup')),
          h('button', {
            type: 'button',
            style: { ...buttonStyle(), opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: compact,
          }, t('data.compact')),
        ),

        plan && plan.totalFiles
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h(Hint, { kind: 'muted' }, t('data.plan', { files: plan.totalFiles, size: plan.totalText })),
            h('div', null, h('button', {
              type: 'button',
              style: { ...buttonStyle('danger'), opacity: busy ? 0.6 : 1 },
              disabled: busy,
              onClick: remove,
            }, t('data.confirm'))),
          )
          : null,

        message ? h(Hint, { kind: message.kind }, message.text) : null,
      )
    }

    // ---------------------------------------------------------------------- page

    const TABS = [
      { id: 'environments', label: 'tab.environments' },
      { id: 'permissions', label: 'tab.permissions' },
      { id: 'plans', label: 'tab.plans' },
      { id: 'data', label: 'tab.data' },
      { id: 'gitlab', label: 'tab.gitlab' },
      { id: 'general', label: 'tab.general' },
    ]

    function SettingsPage() {
      useLocaleRevision()
      const [tab, setTab] = React.useState('environments')
      const [pending, setPending] = React.useState(0)

      const panels = {
        environments: h(EnvironmentsPanel),
        permissions: h(PermissionsPanel),
        plans: h(PlansPanel, { onCount: setPending }),
        data: h(StoragePanel),
        gitlab: h(GitlabPanel),
        general: h(GeneralPanel),
      }

      const tabBar = h('div', {
        style: {
          display: 'flex',
          gap: '2px',
          borderBottom: `1px solid ${T.border}`,
          marginBottom: '2px',
        },
      }, TABS.map((item) => {
        const active = tab === item.id
        const suffix = item.id === 'plans' && pending ? ` (${pending})` : ''
        return h('button', {
          key: item.id,
          type: 'button',
          onClick: () => setTab(item.id),
          style: {
            padding: '7px 12px',
            font: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            borderBottom: `2px solid ${active ? T.brand : 'transparent'}`,
            color: active ? T.text : T.muted,
            fontWeight: active ? 600 : 400,
            marginBottom: '-1px',
          },
        }, t(item.label) + suffix)
      }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '840px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('h2', { style: { margin: 0, fontSize: '15px', fontWeight: 600, color: T.text } }, t('section.title')),
          h('p', { style: { margin: 0, fontSize: '12px', color: T.muted, lineHeight: 1.5 } }, t('section.desc')),
        ),
        tabBar,
        // Every panel stays mounted so switching tabs does not discard edits
        // or restart a connection test.
        ...TABS.map((item) => h('div', {
          key: item.id,
          style: { display: tab === item.id ? 'block' : 'none' },
        }, panels[item.id])),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The `locale` service is provided by @deepseek-ai/dsh-client-locale,
        // which may activate after this plugin. A one-shot `ctx.get('locale')`
        // read would then be undefined forever and the page would stay English
        // — the reported "settings page does not follow DSH's language" bug.
        // `ctx.inject` waits for the service and re-runs this body if it is
        // replaced, so the wiring is late-safe and self-healing.
        ctx.inject(['locale'], (ctx) => {
          const locale = ctx.locale
          localeService = locale
          ctx.effect(() => () => {
            if (localeService === locale) localeService = null
          })

          const sync = () => {
            const live = activeIdOf(locale)
            if (live) activeLocale = localeFrom(live)
            notifyLocale()
          }
          sync()
          ctx.effect(() => locale.subscribe?.(sync) ?? (() => {}))
          // Registration is a courtesy for other surfaces reading this
          // namespace; the page never depends on it succeeding.
          ctx.effect(() => {
            try {
              return locale.register('d365-meta', DICT)
            } catch {
              return () => {}
            }
          })
        })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'd365-meta',
          order: 30,
          label: () => t('section.title'),
        }, SettingsPage))
      },
    }
  },
})
