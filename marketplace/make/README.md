# Frihet ERP App Specification for Make.com (Integromat)

Official integration specification for building automated visual business scenarios on [Make.com](https://www.make.com).

## Modules

### Triggers
1. **Watch Invoices:** Instant webhook trigger when invoices are created, sent, or paid (`invoice_created`, `invoice_paid`).
2. **Watch Expenses:** Instant webhook trigger when deductible expenses are logged.

*Webhooks are signed using HMAC-SHA256 (`x-frihet-signature`).*

### Actions
1. **Create Draft Invoice:** Creates a customer invoice strictly with `status: 'draft'`. Invoices must be reviewed or confirmed before formal tax submission.
2. **Create Client:** Adds a customer to Frihet ERP with NIF/CIF tax identifier and billing details.
3. **Get Monthly Summary:** Retrieves monthly revenue, deductible expenses, and estimated VAT liabilities.

## Setup in Make Custom Apps
1. In Make Developer Console, click **Create App** and name it **Frihet ERP**.
2. Import `app-definition.json`.
3. Set base URL to `https://api.frihet.io/v1`.
4. Configure API Key authentication in connection settings.
