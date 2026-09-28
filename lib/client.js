// dsh-deepseek-budget — client half (hand-written bundle; no build step).
// `react` is a platform seed module. The browser holds no credential: it only
// reads the report the host computed from local session logs.

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-budget',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var REPORT_URL = '/deepseek-budget/report'
    var ACCOUNT_URL = '/deepseek-budget/account'

    var COLOR = {
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
      over: 'var(--dsw-alias-state-error-primary, #dc2626)',
      label: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      track: 'var(--dsw-alias-bg-l2, rgba(128,128,128,0.18))',
    }

    var WINDOWS = [
      { id: 'today', label: 'Today' },
      { id: '7d', label: '7 days' },
      { id: '30d', label: '30 days' },
      { id: 'all', label: 'All' },
    ]

    var ROW_STYLE = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '6px 0',
      borderBottom: '1px solid ' + COLOR.border,
      fontSize: '12px',
    }

    function fmtTokens(value) {
      var n = Number(value) || 0
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    function fmtUSD(value) {
      var n = Number(value) || 0
      if (n === 0) return '$0.00'
      if (n < 0.01) return '$' + n.toFixed(4)
      return '$' + n.toFixed(2)
    }

    function fmtMs(value) {
      if (value === null || value === undefined) return '-'
      var n = Math.round(Number(value))
      return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms'
    }

    function fmtRate(value) {
      if (value === null || value === undefined) return '-'
      return Number(value).toFixed(1) + ' tok/s'
    }

    var CURRENCY_SYMBOL = { EUR: '\u20ac', USD: '$', CNY: '\u00a5' }

    function fmtMoney(value, currency) {
      if (value === null || value === undefined) return '-'
      var symbol = CURRENCY_SYMBOL[currency] || ''
      var amount = Number(value)
      var text = Math.abs(amount) < 1 ? amount.toFixed(4) : amount.toFixed(2)
      return symbol ? symbol + text : text + ' ' + (currency || '')
    }

    function reasonText(reason) {
      var text = {
        no_api_key: 'no DeepSeek API key configured',
        no_user_token: 'needs a platform user token (see README)',
        key_rejected: 'API key rejected',
        token_rejected: 'user token rejected or expired',
        timeout: 'the request timed out',
        network_error: 'network error',
      }[reason]
      if (text) return text
      return reason ? 'unavailable (' + reason + ')' : 'unavailable'
    }

    function pct(value) {
      var n = Math.max(0, Math.min(1, Number(value) || 0))
      return (n * 100).toFixed(1) + '%'
    }

    function Meter(ctx) {
      return function BudgetMeter() {
        var windowState = React.useState('all')
        var windowId = windowState[0]
        var setWindowId = windowState[1]
        var reportState = React.useState(null)
        var report = reportState[0]
        var setReport = reportState[1]
        var errorState = React.useState(null)
        var error = errorState[0]
        var setError = errorState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var accountState = React.useState(null)
        var account = accountState[0]
        var setAccount = accountState[1]

        function load(next) {
          var target = next || windowId
          setBusy(true)
          return fetch(REPORT_URL + '?window=' + encodeURIComponent(target))
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (value) {
              setReport(value)
              setError(null)
            })
            .catch(function (failure) {
              setError(String((failure && failure.message) || failure))
            })
            .then(function () {
              setBusy(false)
            })
        }

        function loadAccount() {
          return fetch(ACCOUNT_URL)
            .then(function (response) { return response.json() })
            .then(setAccount)
            .catch(function () {})
        }

        React.useEffect(function () {
          load(windowId)
          loadAccount()
          return ctx.interval(function () {
            loadAccount()
            fetch(REPORT_URL + '?window=' + encodeURIComponent(windowId))
              .then(function (response) { return response.json() })
              .then(setReport)
              .catch(function () {})
          }, 30000)
        }, [windowId])

        var totals = report ? report.totals : null
        var budget = report ? report.budget : null
        var used = budget ? budget.usedFraction : 0
        var color = used >= 1 ? COLOR.over : used >= 0.75 ? COLOR.warn : COLOR.ok
        var rows = []

        if (error) {
          rows.push(React.createElement('div', { key: 'error', style: { color: COLOR.over, fontSize: '12px' } },
            'Measurement failed: ' + error))
        }

        rows.push(React.createElement('div', {
          key: 'controls',
          style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' },
        },
        WINDOWS.map(function (entry) {
          return React.createElement('button', {
            key: entry.id,
            type: 'button',
            onClick: function () { setWindowId(entry.id) },
            style: {
              padding: '4px 10px',
              fontSize: '12px',
              borderRadius: '6px',
              cursor: 'pointer',
              border: '1px solid ' + COLOR.border,
              background: entry.id === windowId ? 'var(--dsw-alias-bg-l2, rgba(128,128,128,0.18))' : 'transparent',
              color: COLOR.label,
              fontWeight: entry.id === windowId ? 600 : 400,
            },
          }, entry.label)
        }),
        React.createElement('button', {
          type: 'button',
          onClick: function () { load(windowId) },
          disabled: busy,
          style: {
            padding: '4px 10px',
            fontSize: '12px',
            borderRadius: '6px',
            cursor: 'pointer',
            border: '1px solid ' + COLOR.border,
            background: 'transparent',
            color: COLOR.muted,
            marginLeft: 'auto',
          },
        }, busy ? 'Refreshing...' : 'Refresh')))

        if (totals && budget) {
          rows.push(React.createElement('div', { key: 'gauge', style: { marginBottom: '18px' } },
            React.createElement('div', {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' },
            },
            React.createElement('div', { style: { fontSize: '22px', fontWeight: 650, color: COLOR.label } },
              fmtUSD(budget.spentUSD)),
            React.createElement('div', { style: { fontSize: '12px', color: COLOR.muted } },
              'of ' + fmtUSD(report.budgetUSD) + ' budget settled - ' + pct(budget.usedFraction) + ' used')),
            React.createElement('div', {
              style: { height: '8px', borderRadius: '4px', background: COLOR.track, overflow: 'hidden' },
            },
            React.createElement('div', {
              style: { height: '100%', width: Math.min(100, budget.usedFraction * 100) + '%', background: color },
            })),
            React.createElement('div', {
              style: { marginTop: '6px', fontSize: '12px', color: budget.overBudget ? COLOR.over : COLOR.muted },
            },
            budget.overBudget
              ? 'Over budget by ' + fmtUSD(-budget.remainingUSD)
              : fmtUSD(budget.remainingUSD) + ' left'
                + (report.headline.callsRemainingInBudget !== null
                  ? ' - about ' + report.headline.callsRemainingInBudget + ' more calls at the current average'
                  : ''))))

          // ---- company account (key-wide) ----
          if (account && account.balance) {
            var company = account.company || {}
            var balance = account.balance
            var accountRows = []

            if (balance.available) {
              balance.currencies.forEach(function (entry) {
                accountRows.push(React.createElement('div', { key: 'bal-' + entry.currency, style: ROW_STYLE },
                  React.createElement('span', { style: { color: COLOR.label } }, 'Balance (' + entry.currency + ')'),
                  React.createElement('span', { style: { color: COLOR.muted } },
                    fmtMoney(entry.total, entry.currency)
                    + ' - granted ' + fmtMoney(entry.granted, entry.currency)
                    + ', topped up ' + fmtMoney(entry.toppedUp, entry.currency))))
              })
            } else {
              accountRows.push(React.createElement('div', { key: 'bal-none', style: ROW_STYLE },
                React.createElement('span', { style: { color: COLOR.muted } }, 'Balance'),
                React.createElement('span', { style: { color: COLOR.muted } }, reasonText(balance.reason))))
            }

            if (account.usage && account.usage.available) {
              accountRows.push(React.createElement('div', { key: 'acct-spend', style: ROW_STYLE },
                React.createElement('span', { style: { color: COLOR.label } },
                  'Whole account this month (' + account.usage.currency + ')'),
                React.createElement('span', { style: { color: COLOR.muted } },
                  fmtMoney(account.usage.cost, account.usage.currency)
                  + ' - ' + fmtTokens(account.usage.tokens) + ' tokens')))
              if (company.usedFraction !== null) {
                accountRows.push(React.createElement('div', { key: 'acct-budget', style: ROW_STYLE },
                  React.createElement('span', { style: { color: COLOR.label } },
                    'Company budget ' + fmtMoney(account.budgetEUR, 'EUR') + ' (' + pct(company.usedFraction) + ' used)'),
                  React.createElement('span', { style: { color: COLOR.muted } },
                    fmtMoney(company.remainingInCurrency, account.usage.currency) + ' left in '
                    + account.usage.currency + ' terms')))
              }
              account.usage.models.slice(0, 6).forEach(function (entry) {
                accountRows.push(React.createElement('div', { key: 'acct-' + entry.model, style: ROW_STYLE },
                  React.createElement('span', { style: { fontFamily: 'monospace', color: COLOR.muted } }, entry.model),
                  React.createElement('span', { style: { color: COLOR.muted } }, fmtMoney(entry.cost, account.usage.currency))))
              })
            } else if (account.usage) {
              accountRows.push(React.createElement('div', { key: 'acct-none', style: ROW_STYLE },
                React.createElement('span', { style: { color: COLOR.muted } }, 'Whole-account usage'),
                React.createElement('span', { style: { color: COLOR.muted } }, reasonText(account.usage.reason))))
            }

            rows.push(React.createElement('div', { key: 'account', style: { marginBottom: '20px' } },
              React.createElement('div', {
                style: { fontSize: '12px', fontWeight: 650, color: COLOR.label, marginBottom: '6px' },
              }, 'Company account (all developers, all API keys)'),
              accountRows))
          }

          var cells = [
            ['Model calls', String(totals.calls)],
            ['Input tokens', fmtTokens(totals.inputTokens) + ' (' + pct(totals.cacheHitRate) + ' cached)'],
            ['Output tokens', fmtTokens(totals.outputTokens)],
            ['Reasoning tokens', fmtTokens(totals.reasoningTokens)],
            ['Avg cost per call', fmtUSD(report.headline.avgCostPerCallUSD)],
            ['Avg billed tokens / call', fmtTokens(report.headline.avgBillableTokensPerCall)],
            ['Avg total tokens / call', fmtTokens(report.headline.avgTokensPerCall) + ' (cache incl.)'],
            ['Time to first token', fmtMs(totals.avgTtftMs) + ' avg'],
            ['Output speed', fmtRate(totals.outputTokensPerSecond)],
            ['Peak / off-peak calls', totals.peakCalls + ' / ' + totals.offPeakCalls],
            ['Cost at peak / off-peak', fmtUSD(totals.costAtPeakUSD) + ' / ' + fmtUSD(totals.costAtOffPeakUSD)],
          ]

          if (report.recordedCostUSD > 0) {
            cells.push(['Harness-reported cost', fmtUSD(report.recordedCostUSD) + ' (cross-check)'])
          }

          rows.push(React.createElement('div', {
            key: 'cells',
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: '10px',
              marginBottom: '20px',
            },
          },
          cells.map(function (cell) {
            return React.createElement('div', {
              key: cell[0],
              style: { border: '1px solid ' + COLOR.border, borderRadius: '8px', padding: '10px 12px' },
            },
            React.createElement('div', {
              style: {
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: COLOR.muted,
              },
            }, cell[0]),
            React.createElement('div', {
              style: { fontSize: '15px', fontWeight: 600, color: COLOR.label, marginTop: '3px' },
            }, cell[1]))
          })))

          rows.push(React.createElement('div', { key: 'models', style: { marginBottom: '20px' } },
            React.createElement('div', {
              style: { fontSize: '12px', fontWeight: 650, color: COLOR.label, marginBottom: '6px' },
            }, 'By model'),
            report.models.length === 0
              ? React.createElement('div', { style: { fontSize: '12px', color: COLOR.muted } },
                'No model calls recorded in this window.')
              : report.models.map(function (entry) {
                return React.createElement('div', { key: entry.provider + entry.model, style: ROW_STYLE },
                  React.createElement('span', { style: { fontFamily: 'monospace', color: COLOR.label } }, entry.model),
                  React.createElement('span', { style: { color: COLOR.muted, textAlign: 'right' } },
                    entry.priced
                      ? fmtUSD(entry.totals.costUSD) + ' - ' + entry.totals.calls + ' calls - '
                        + fmtTokens(entry.totals.totalTokens) + ' tok - ' + pct(entry.totals.cacheHitRate) + ' cached'
                      : entry.totals.calls + ' calls - not billed on the DeepSeek key'))
              })))

          if (report.sources && report.sources.length > 0) {
            rows.push(React.createElement('div', { key: 'sources', style: { marginBottom: '20px' } },
              React.createElement('div', {
                style: { fontSize: '12px', fontWeight: 650, color: COLOR.label, marginBottom: '6px' },
              }, 'Harnesses counted'),
              report.sources.map(function (source) {
                return React.createElement('div', { key: source.id, style: ROW_STYLE },
                  React.createElement('span', { style: { color: source.missing ? COLOR.danger : COLOR.label } },
                    source.label + (source.missing ? ' - unavailable' : '')),
                  React.createElement('span', { style: { color: COLOR.muted, textAlign: 'right' } },
                    source.calls + ' DeepSeek call(s)' + (source.detail ? ' - ' + source.detail : '')))
              })))
          }

          if (report.days.length > 0) {
            rows.push(React.createElement('div', { key: 'days', style: { marginBottom: '20px' } },
              React.createElement('div', {
                style: { fontSize: '12px', fontWeight: 650, color: COLOR.label, marginBottom: '6px' },
              }, 'By day (UTC)'),
              report.days.slice(0, 14).map(function (entry) {
                return React.createElement('div', { key: entry.day, style: ROW_STYLE },
                  React.createElement('span', { style: { fontFamily: 'monospace', color: COLOR.label } }, entry.day),
                  React.createElement('span', { style: { color: COLOR.muted } },
                    fmtUSD(entry.totals.costUSD) + ' - ' + entry.totals.calls + ' calls - '
                    + fmtTokens(entry.totals.totalTokens) + ' tok'))
              })))
          }

          rows.push(React.createElement('div', {
            key: 'note',
            style: { fontSize: '11px', color: COLOR.muted, lineHeight: 1.5 },
          },
          'Measured from provider-reported usage in every counted harness on this machine, '
          + 'at DeepSeek list prices. Only DeepSeek routes are counted. '
          + (report.recordedCostUSD > 0
            ? 'Harness-reported costs use older rate tables and read lower than list prices. '
            : '')
          + (report.unpriced.calls > 0
            ? report.unpriced.calls + ' call(s) on other providers are counted separately and excluded from the budget. '
            : '')
          + 'Peak hours are UTC 01:00-04:00 and 06:00-10:00 on weekdays.'))
        } else if (!error) {
          rows.push(React.createElement('div', { key: 'loading', style: { fontSize: '12px', color: COLOR.muted } },
            'Measuring...'))
        }

        return React.createElement('div', {
          style: { padding: '2px 0', fontSize: '13px', color: COLOR.label },
        }, rows)
      }
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'deepseek-budget', order: 30, label: 'DeepSeek Budget' },
          Meter(ctx),
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'timer']
    return module.exports
  },
})
