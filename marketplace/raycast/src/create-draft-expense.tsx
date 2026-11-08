import React, { useState } from 'react';
import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  popToRoot,
  Icon,
} from '@raycast/api';
import { createDraftExpense } from './api';

interface ExpenseFormValues {
  vendor: string;
  amount: string;
  category: string;
  vatRate: string;
  date: Date | null;
  notes: string;
}

export default function CreateDraftExpenseCommand() {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [vendorError, setVendorError] = useState<string | undefined>();
  const [amountError, setAmountError] = useState<string | undefined>();

  async function handleSubmit(values: ExpenseFormValues) {
    if (!values.vendor.trim()) {
      setVendorError('Vendor name is required');
      return;
    }
    setVendorError(undefined);

    const numericAmount = parseFloat(values.amount.replace(',', '.'));
    if (isNaN(numericAmount) || numericAmount <= 0) {
      setAmountError('Please enter a valid positive amount');
      return;
    }
    setAmountError(undefined);

    setIsLoading(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Recording draft expense...',
    });

    try {
      const formattedDate = values.date
        ? values.date.toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      await createDraftExpense({
        vendor: values.vendor.trim(),
        amount: numericAmount,
        category: values.category || 'General',
        vatRate: parseFloat(values.vatRate) || 21,
        date: formattedDate,
        notes: values.notes?.trim() || undefined,
      });

      toast.style = Toast.Style.Success;
      toast.title = 'Draft expense recorded';
      toast.message = 'Saved for bookkeeper review in Frihet ERP';

      await popToRoot();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to record expense';
      toast.message = error instanceof Error ? error.message : String(error);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create Draft Expense"
            icon={Icon.PlusCircle}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="vendor"
        title="Vendor"
        placeholder="e.g. AWS, Adobe, Office Depot"
        error={vendorError}
        onChange={() => setVendorError(undefined)}
      />
      <Form.TextField
        id="amount"
        title="Amount (€)"
        placeholder="0.00"
        error={amountError}
        onChange={() => setAmountError(undefined)}
      />
      <Form.Dropdown id="category" title="Category" defaultValue="Software">
        <Form.Dropdown.Item value="Software" title="Software & Subscriptions" icon={Icon.Desktop} />
        <Form.Dropdown.Item value="Office" title="Office Supplies" icon={Icon.Box} />
        <Form.Dropdown.Item value="Travel" title="Travel & Meals" icon={Icon.Airplane} />
        <Form.Dropdown.Item value="Marketing" title="Marketing & Ads" icon={Icon.Megaphone} />
        <Form.Dropdown.Item value="Services" title="Professional Services" icon={Icon.Person} />
        <Form.Dropdown.Item value="General" title="General & Other" icon={Icon.Tag} />
      </Form.Dropdown>
      <Form.Dropdown id="vatRate" title="VAT / IVA Rate" defaultValue="21">
        <Form.Dropdown.Item value="21" title="21% Standard (General)" />
        <Form.Dropdown.Item value="10" title="10% Reduced (Reducido)" />
        <Form.Dropdown.Item value="4" title="4% Super-reduced (Superreducido)" />
        <Form.Dropdown.Item value="0" title="0% Exempt / Zero-rate" />
      </Form.Dropdown>
      <Form.DatePicker id="date" title="Expense Date" defaultValue={new Date()} />
      <Form.TextArea
        id="notes"
        title="Notes"
        placeholder="Optional notes or business reason for receipt audit..."
      />
      <Form.Description text="💡 Draft Invariant: Created expenses enter reviewable draft status and do not file tax returns." />
    </Form>
  );
}
