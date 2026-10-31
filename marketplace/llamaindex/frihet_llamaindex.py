"""
Frihet ERP ToolSpec for LlamaIndex.

Provides native LlamaIndex FunctionTools for financial queries, tax summaries,
and reviewable draft invoicing in compliance with European/Spanish fiscal standards.
"""

import os
import urllib.parse
from typing import Any, Dict, List, Optional
import requests
from pydantic import BaseModel, Field

try:
    from llama_index.core.tools.tool_spec.base import BaseToolSpec
    from llama_index.core.tools.function_tool import FunctionTool
except ImportError:
    # Graceful fallback if llama-index-core is not yet installed
    class BaseToolSpec:  # type: ignore
        spec_functions: List[str] = []

    class FunctionTool:  # type: ignore
        @classmethod
        def from_defaults(cls, fn: Any, name: Optional[str] = None, description: Optional[str] = None):
            return {"fn": fn, "name": name, "description": description}


class DraftInvoiceItem(BaseModel):
    description: str = Field(description="Line item description")
    quantity: float = Field(default=1.0, gt=0, description="Quantity units")
    unit_price: float = Field(description="Net price per unit in EUR")
    vat_rate: float = Field(default=21.0, description="VAT percentage (e.g. 21, 10, 4, 0)")


class FrihetToolSpec(BaseToolSpec):
    """LlamaIndex ToolSpec connecting LLMs to Frihet ERP."""

    spec_functions = [
        "get_business_context",
        "get_monthly_summary",
        "get_quarterly_taxes",
        "list_invoices",
        "get_invoice",
        "create_draft_invoice",
        "list_expenses",
        "create_expense",
        "list_clients",
        "create_client",
    ]

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.api_key = api_key or os.environ.get("FRIHET_API_KEY", "")
        self.base_url = (base_url or os.environ.get("FRIHET_API_BASE_URL", "https://api.frihet.io/v1")).rstrip("/")

    def _request(self, endpoint: str, method: str = "GET", json_data: Optional[Dict[str, Any]] = None, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Frihet-LlamaIndex-Toolkit/1.0.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["x-frihet-api-key"] = self.api_key

        url = f"{self.base_url}{endpoint}"
        resp = requests.request(method, url, headers=headers, json=json_data, params=params, timeout=30)
        if not resp.ok:
            raise RuntimeError(f"Frihet API error ({resp.status_code}): {resp.text}")
        return resp.json()

    def get_business_context(self) -> Dict[str, Any]:
        """Get high-level overview of the connected business, currency, fiscal regime, and active limits."""
        return self._request("/context")

    def get_monthly_summary(self, year: int, month: int) -> Dict[str, Any]:
        """Retrieve monthly financial summary including revenue, deductible expenses, net margin, and cash."""
        return self._request(f"/summaries/monthly", params={"year": year, "month": month})

    def get_quarterly_taxes(self, year: int, quarter: int) -> Dict[str, Any]:
        """Retrieve estimated quarterly tax breakdown (Modelo 303 VAT, Modelo 130 IRPF installment)."""
        return self._request(f"/taxes/quarterly", params={"year": year, "quarter": quarter})

    def list_invoices(self, status: Optional[str] = None, client_id: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """List and search customer invoices with optional filters for status and client ID."""
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if client_id:
            params["clientId"] = client_id
        return self._request("/invoices", params=params)

    def get_invoice(self, invoice_id: str) -> Dict[str, Any]:
        """Retrieve complete details for a single invoice by its unique ID."""
        safe_id = urllib.parse.quote(invoice_id, safe="")
        return self._request(f"/invoices/{safe_id}")

    def create_draft_invoice(self, client_id: str, items: List[Dict[str, Any]], notes: Optional[str] = None) -> Dict[str, Any]:
        """Create an invoice in strictly DRAFT status. Human confirmation required before issuance."""
        payload = {
            "clientId": client_id,
            "items": items,
            "notes": notes,
            "status": "draft",  # Strict draft invariant
        }
        return self._request("/invoices", method="POST", json_data=payload)

    def list_expenses(self, category: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """Query deductible business expenses and receipts with category filter."""
        params: Dict[str, Any] = {"limit": limit}
        if category:
            params["category"] = category
        return self._request("/expenses", params=params)

    def create_expense(self, vendor: str, amount: float, vat_rate: float = 21.0, category: str = "General", date: Optional[str] = None) -> Dict[str, Any]:
        """Record a deductible business expense or supplier invoice."""
        payload = {
            "vendor": vendor,
            "amount": amount,
            "vatRate": vat_rate,
            "category": category,
            "date": date,
        }
        return self._request("/expenses", method="POST", json_data=payload)

    def list_clients(self, search: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """Search and list registered clients by name, tax ID (NIF/CIF), or email."""
        params: Dict[str, Any] = {"limit": limit}
        if search:
            params["search"] = search
        return self._request("/clients", params=params)

    def create_client(self, name: str, tax_id: str, email: str, country: str = "ES") -> Dict[str, Any]:
        """Register a new customer or business client."""
        payload = {
            "name": name,
            "taxId": tax_id,
            "email": email,
            "country": country,
        }
        return self._request("/clients", method="POST", json_data=payload)

    def to_tool_list(self) -> List[Any]:
        """Export as a list of LlamaIndex FunctionTools."""
        return [
            FunctionTool.from_defaults(fn=self.get_business_context, name="frihet_get_business_context"),
            FunctionTool.from_defaults(fn=self.get_monthly_summary, name="frihet_get_monthly_summary"),
            FunctionTool.from_defaults(fn=self.get_quarterly_taxes, name="frihet_get_quarterly_taxes"),
            FunctionTool.from_defaults(fn=self.list_invoices, name="frihet_list_invoices"),
            FunctionTool.from_defaults(fn=self.get_invoice, name="frihet_get_invoice"),
            FunctionTool.from_defaults(fn=self.create_draft_invoice, name="frihet_create_draft_invoice"),
            FunctionTool.from_defaults(fn=self.list_expenses, name="frihet_list_expenses"),
            FunctionTool.from_defaults(fn=self.create_expense, name="frihet_create_expense"),
            FunctionTool.from_defaults(fn=self.list_clients, name="frihet_list_clients"),
            FunctionTool.from_defaults(fn=self.create_client, name="frihet_create_client"),
        ]
