"""
Frihet ERP ToolSpec for LlamaIndex.

Provides native LlamaIndex FunctionTools for financial queries, tax summaries,
and reviewable draft invoicing in compliance with European/Spanish fiscal standards.
"""

import os
import uuid
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


SENSITIVE_KEYS = {"taxId", "iban", "token", "secret", "apiKey", "password", "verifactuHash"}


def redact_sensitive_data(obj: Any) -> Any:
    """Recursively redacts sensitive identifiers from API responses."""
    if isinstance(obj, dict):
        return {
            k: ("[REDACTED]" if k in SENSITIVE_KEYS else redact_sensitive_data(v))
            for k, v in obj.items()
        }
    elif isinstance(obj, list):
        return [redact_sensitive_data(item) for item in obj]
    return obj


class DraftInvoiceItem(BaseModel):
    description: str = Field(description="Line item description")
    quantity: float = Field(default=1.0, gt=0, description="Quantity units (must be > 0)")
    unit_price: float = Field(ge=0, description="Net price per unit in EUR (must be >= 0)")
    vat_rate: float = Field(default=21.0, ge=0, description="VAT percentage (e.g. 21, 10, 4, 0)")


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

    def _request(
        self,
        endpoint: str,
        method: str = "GET",
        json_data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Frihet-LlamaIndex-Toolkit/1.0.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["x-frihet-api-key"] = self.api_key

        if method in ("POST", "PATCH", "DELETE"):
            headers["Idempotency-Key"] = str(uuid.uuid4())

        url = f"{self.base_url}{endpoint}"
        resp = requests.request(method, url, headers=headers, json=json_data, params=params, timeout=30)
        if not resp.ok:
            raise RuntimeError(f"Frihet API error ({resp.status_code}): {resp.text}")

        resp_json = resp.json()
        return redact_sensitive_data(resp_json)

    def get_business_context(self) -> Dict[str, Any]:
        """Get high-level overview of the connected business, currency, fiscal regime, and active limits."""
        return self._request("/context")

    def get_monthly_summary(self, year: int, month: int) -> Dict[str, Any]:
        """Retrieve monthly financial summary including revenue, deductible expenses, net margin, and cash."""
        month_str = f"{year:04d}-{month:02d}"
        return self._request("/monthly", params={"month": month_str})

    def get_quarterly_taxes(self, year: int, quarter: int) -> Dict[str, Any]:
        """Retrieve estimated quarterly tax breakdown (Modelo 303 VAT, Modelo 130 IRPF installment)."""
        quarter_str = f"{year:04d}-Q{quarter}"
        return self._request("/quarterly", params={"quarter": quarter_str})

    def list_invoices(self, status: Optional[str] = None, client_id: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """List and search customer invoices with optional filters for status and client ID."""
        params: Dict[str, Any] = {"limit": min(limit, 100)}
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
        validated_items = [DraftInvoiceItem(**item).model_dump() for item in items]
        payload = {
            "clientId": client_id,
            "items": validated_items,
            "notes": notes,
            "status": "draft",  # Strict draft-only invariant
        }
        return self._request("/invoices", method="POST", json_data=payload)

    def list_expenses(self, category: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """List recorded business expenses with category filtering and deductibility details."""
        params: Dict[str, Any] = {"limit": min(limit, 100)}
        if category:
            params["category"] = category
        return self._request("/expenses", params=params)

    def create_expense(self, vendor: str, amount: float, category: str = "General", vat_rate: float = 21.0, date: Optional[str] = None) -> Dict[str, Any]:
        """Record a business expense/receipt in draft status."""
        payload = {
            "vendor": vendor,
            "amount": amount,
            "category": category,
            "vatRate": vat_rate,
            "date": date,
            "status": "draft",
        }
        return self._request("/expenses", method="POST", json_data=payload)

    def list_clients(self, search: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """List registered clients with optional search by company name, tax ID, or email."""
        params: Dict[str, Any] = {"limit": min(limit, 100)}
        if search:
            params["search"] = search
        return self._request("/clients", params=params)

    def create_client(self, name: str, email: str, country: str = "ES", tax_id: Optional[str] = None) -> Dict[str, Any]:
        """Register a new customer profile with billing details."""
        payload = {
            "name": name,
            "email": email,
            "country": country,
            "taxId": tax_id,
        }
        return self._request("/clients", method="POST", json_data=payload)
