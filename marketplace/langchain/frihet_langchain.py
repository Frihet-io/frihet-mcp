"""Frihet ERP — LangChain Native Toolkit.

Integrates Frihet ERP with LangChain and LangGraph for enterprise agent workflows.
All financial write operations enforce strict draft boundaries.
"""

from __future__ import annotations

import json
import os
import uuid
import urllib.request
import urllib.error
import urllib.parse
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

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


try:
    from langchain_core.tools import BaseTool
except ImportError:
    # Standalone mock if langchain_core is not present
    class BaseTool:  # type: ignore[no-redef]
        name: str
        description: str
        args_schema: Any = None

        def __init__(self, **kwargs: Any) -> None:
            for k, v in kwargs.items():
                setattr(self, k, v)


class FrihetApi:
    """Internal HTTP dispatcher for Frihet REST API."""

    def __init__(self, api_key: Optional[str] = None, base_url: str = "https://api.frihet.io/v1") -> None:
        self.api_key = api_key or os.getenv("FRIHET_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    def execute(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Frihet-LangChain-Toolkit/1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["x-frihet-api-key"] = self.api_key

        if method in ("POST", "PATCH", "DELETE"):
            headers["Idempotency-Key"] = str(uuid.uuid4())

        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8")
                res = json.loads(body) if body else {}
                return redact_sensitive_data(res)
        except urllib.error.HTTPError as e:
            return {"error": True, "status": e.code, "message": e.read().decode("utf-8") if e.fp else str(e)}
        except Exception as e:
            return {"error": True, "message": str(e)}


# Tool 1: Business Context
class BusinessContextSchema(BaseModel):
    include_limits: bool = Field(default=True, description="Include company tier and usage limits")


class FrihetBusinessContextTool(BaseTool):
    name: str = "frihet_business_context"
    description: str = (
        "Get company financial snapshot, unpaid balances, tax withholdings, and currency configuration."
    )
    args_schema: type[BaseModel] = BusinessContextSchema
    api: FrihetApi = Field(default_factory=FrihetApi)

    def _run(self, include_limits: bool = True) -> str:
        res = self.api.execute("GET", f"/context?includeLimits={str(include_limits).lower()}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# Tool 2: List Invoices
class ListInvoicesSchema(BaseModel):
    status: Optional[str] = Field(None, description="Optional filter: 'draft', 'issued', 'paid', or 'overdue'")
    limit: int = Field(default=20, ge=1, le=100, description="Max records to return")


class FrihetListInvoicesTool(BaseTool):
    name: str = "frihet_list_invoices"
    description: str = "Search and list customer invoices in Frihet ERP with status, dates, and amounts."
    args_schema: type[BaseModel] = ListInvoicesSchema
    api: FrihetApi = Field(default_factory=FrihetApi)

    def _run(self, status: Optional[str] = None, limit: int = 20) -> str:
        query = f"?limit={limit}" + (f"&status={status}" if status else "")
        res = self.api.execute("GET", f"/invoices{query}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# Tool 3: Draft Invoice
class LineItemSchema(BaseModel):
    description: str = Field(..., description="Description of service or goods")
    quantity: float = Field(..., ge=0.01, description="Quantity")
    unitPrice: float = Field(..., ge=0, description="Unit price before tax")
    taxRate: Optional[float] = Field(21.0, description="VAT percentage (e.g. 21.0, 10.0, 0.0)")


class DraftInvoiceSchema(BaseModel):
    clientId: str = Field(..., description="Target client identifier")
    items: List[LineItemSchema] = Field(..., description="Line items for the invoice draft")
    notes: Optional[str] = Field(None, description="Draft notes")


class FrihetDraftInvoiceTool(BaseTool):
    name: str = "frihet_draft_invoice"
    description: str = (
        "Create an invoice draft in Frihet ERP. Strictly non-destructive; produces a reviewable draft. "
        "Never submits to fiscal authorities directly."
    )
    args_schema: type[BaseModel] = DraftInvoiceSchema
    api: FrihetApi = Field(default_factory=FrihetApi)

    def _run(self, clientId: str, items: List[Dict[str, Any]], notes: Optional[str] = None) -> str:
        payload: Dict[str, Any] = {
            "clientId": clientId,
            "status": "draft",
            "items": [item if isinstance(item, dict) else item.model_dump() for item in items],
        }
        if notes:
            payload["notes"] = notes
        res = self.api.execute("POST", "/invoices", payload=payload)
        return json.dumps(res, indent=2, ensure_ascii=False)


# Tool 4: List Expenses
class ListExpensesSchema(BaseModel):
    category: Optional[str] = Field(None, description="Filter category")
    limit: int = Field(default=25, ge=1, le=100, description="Records limit")


class FrihetListExpensesTool(BaseTool):
    name: str = "frihet_list_expenses"
    description: str = "Query recorded expenses and deductibility breakdown for accounting and tax preparation."
    args_schema: type[BaseModel] = ListExpensesSchema
    api: FrihetApi = Field(default_factory=FrihetApi)

    def _run(self, category: Optional[str] = None, limit: int = 25) -> str:
        query = f"?limit={limit}" + (f"&category={category}" if category else "")
        res = self.api.execute("GET", f"/expenses{query}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# Tool 5: Search Clients
class SearchClientsSchema(BaseModel):
    query: Optional[str] = Field(None, description="Search term matching client name or tax ID")
    limit: int = Field(default=20, ge=1, le=100, description="Records limit")


class FrihetSearchClientsTool(BaseTool):
    name: str = "frihet_search_clients"
    description: str = "Search client directory by name, tax ID (NIF/CIF), or contact email."
    args_schema: type[BaseModel] = SearchClientsSchema
    api: FrihetApi = Field(default_factory=FrihetApi)

    def _run(self, query: Optional[str] = None, limit: int = 20) -> str:
        params = f"?limit={limit}" + (f"&q={urllib.parse.quote(query)}" if query else "")
        res = self.api.execute("GET", f"/clients{params}")
        return json.dumps(res, indent=2, ensure_ascii=False)


class FrihetToolkit:
    """LangChain toolkit provider for Frihet ERP operations."""

    def __init__(self, api_key: Optional[str] = None, base_url: str = "https://api.frihet.io/v1") -> None:
        self.api = FrihetApi(api_key=api_key, base_url=base_url)

    def get_tools(self) -> List[Any]:
        return [
            FrihetBusinessContextTool(api=self.api),
            FrihetListInvoicesTool(api=self.api),
            FrihetDraftInvoiceTool(api=self.api),
            FrihetListExpensesTool(api=self.api),
            FrihetSearchClientsTool(api=self.api),
        ]
