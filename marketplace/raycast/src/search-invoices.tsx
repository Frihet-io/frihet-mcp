import React, { useState, useEffect } from 'react';
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
} from '@raycast/api';
import { fetchInvoices } from './api';
import { Invoice } from './types';

export default function SearchInvoicesCommand() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  async function loadInvoices() {
    setIsLoading(true);
    try {
      const data = await fetchInvoices(statusFilter);
      setInvoices(data);
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load invoices',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadInvoices();
  }, [statusFilter]);

  function getStatusBadge(status: string) {
    switch (status) {
      case 'paid':
        return { text: 'Paid', color: Color.Green, icon: Icon.CheckCircle };
      case 'sent':
        return { text: 'Sent', color: Color.Blue, icon: Icon.Envelope };
      case 'draft':
        return { text: 'Draft', color: Color.Orange, icon: Icon.Pencil };
      case 'overdue':
        return { text: 'Overdue', color: Color.Red, icon: Icon.ExclamationMark };
      default:
        return { text: status, color: Color.SecondaryText, icon: Icon.Document };
    }
  }

  function formatCurrency(amount: number, currency = 'EUR') {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency,
    }).format(amount);
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter invoices by client name or number..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by Status"
          value={statusFilter}
          onChange={(newStatus) => setStatusFilter(newStatus)}
        >
          <List.Dropdown.Item title="All Invoices" value="all" />
          <List.Dropdown.Item title="Draft" value="draft" icon={Icon.Pencil} />
          <List.Dropdown.Item title="Sent" value="sent" icon={Icon.Envelope} />
          <List.Dropdown.Item title="Paid" value="paid" icon={Icon.CheckCircle} />
          <List.Dropdown.Item title="Overdue" value="overdue" icon={Icon.ExclamationMark} />
        </List.Dropdown>
      }
    >
      {invoices.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Document}
          title="No Invoices Found"
          description="No customer invoices match the current filter."
        />
      ) : (
        invoices.map((invoice) => {
          const badge = getStatusBadge(invoice.status);
          const title = invoice.invoiceNumber || `Draft #${invoice.id.slice(0, 8)}`;
          const client = invoice.clientName || 'Unknown Client';
          const formattedAmount = formatCurrency(invoice.total, invoice.currency || 'EUR');
          const webUrl = `https://app.frihet.io/invoices/${encodeURIComponent(invoice.id)}`;

          return (
            <List.Item
              key={invoice.id}
              icon={badge.icon}
              title={title}
              subtitle={client}
              accessories={[
                { text: formattedAmount },
                { tag: { value: badge.text, color: badge.color } },
                invoice.dueDate ? { text: `Due: ${invoice.dueDate}` } : {},
              ]}
              actions={
                <ActionPanel>
                  <Action.OpenInBrowser title="Open in Frihet ERP" url={webUrl} />
                  {invoice.paymentUrl && (
                    <Action.CopyToClipboard
                      title="Copy Public Payment Link"
                      content={invoice.paymentUrl}
                      shortcut={{ modifiers: ['cmd'], key: 'p' }}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="Copy Invoice ID"
                    content={invoice.id}
                    shortcut={{ modifiers: ['cmd'], key: 'c' }}
                  />
                  <Action
                    title="Reload Invoices"
                    icon={Icon.ArrowClockwise}
                    onAction={loadInvoices}
                    shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
