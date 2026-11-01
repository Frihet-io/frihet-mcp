import React, { useState, useEffect } from 'react';
import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
} from '@raycast/api';
import { fetchMonthlySummary } from './api';
import { MonthlySummary } from './types';

export default function MonthlySummaryCommand() {
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  async function loadSummary() {
    setIsLoading(true);
    try {
      const data = await fetchMonthlySummary();
      setSummary(data);
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load summary',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadSummary();
  }, []);

  function formatEur(amount: number) {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
    }).format(amount);
  }

  const markdown = summary
    ? `
# Financial Performance — ${summary.month}

Overview of billed revenue, deductible expenses, and net margin calculated from Frihet ERP canonical records.

---

### **Operating Summary**
- **Billed Revenue:** \`${formatEur(summary.revenue)}\`
- **Deductible Expenses:** \`${formatEur(summary.expenses)}\`
- **Net Operating Margin:** \`${formatEur(summary.netMargin)}\`
${summary.cashBalance !== undefined ? `- **Available Cash:** \`${formatEur(summary.cashBalance)}\`` : ''}
${summary.estimatedVat !== undefined ? `- **Estimated VAT (Modelo 303):** \`${formatEur(summary.estimatedVat)}\`` : ''}

> *All amounts calculated in real-time according to Spanish/European fiscal standards.*
`
    : '# Loading Financial Summary...';

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      metadata={
        summary && (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Period" text={summary.month} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label
              title="Revenue"
              text={{ value: formatEur(summary.revenue), color: Color.Green }}
              icon={Icon.BankNote}
            />
            <Detail.Metadata.Label
              title="Expenses"
              text={{ value: formatEur(summary.expenses), color: Color.Orange }}
              icon={Icon.Cart}
            />
            <Detail.Metadata.Label
              title="Net Margin"
              text={{
                value: formatEur(summary.netMargin),
                color: summary.netMargin >= 0 ? Color.Green : Color.Red,
              }}
              icon={Icon.LineChart}
            />
            {summary.estimatedVat !== undefined && (
              <>
                <Detail.Metadata.Separator />
                <Detail.Metadata.Label
                  title="VAT Balance"
                  text={formatEur(summary.estimatedVat)}
                  icon={Icon.Receipt}
                />
              </>
            )}
          </Detail.Metadata>
        )
      }
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open Intelligence in Frihet ERP"
            url="https://app.frihet.io/intelligence"
            icon={Icon.Globe}
          />
          {summary && (
            <Action.CopyToClipboard
              title="Copy Summary Report"
              content={`Frihet Summary (${summary.month}): Revenue: ${formatEur(summary.revenue)}, Expenses: ${formatEur(summary.expenses)}, Net: ${formatEur(summary.netMargin)}`}
              icon={Icon.Clipboard}
            />
          )}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={loadSummary}
            shortcut={{ modifiers: ['cmd'], key: 'r' }}
          />
        </ActionPanel>
      }
    />
  );
}
