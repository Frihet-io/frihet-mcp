"""Frihet ERP — CrewAI Native Tools & Multi-Agent Toolkit.

Enables autonomous agent teams (CFO Agent, Invoicing Agent, Billing & Collections Agent)
to query and manage business operations in Frihet ERP with human-in-the-loop safety fences.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional
import urllib.request
import urllib.error
from pydantic import BaseModel, Field

try:
    from crewai.tools import BaseTool
except ImportError:
    # Standalone fallback if crewai is not pre-installed in the environment
    class BaseTool:  # type: ignore[no-redef]
        name: str
        description: str
        args_schema: Any = None

        def __init__(self, **kwargs: Any) -> None:
            for k, v in kwargs.items():
                setattr(self, k, v)


class FrihetClientBase:
    """Lightweight HTTP client communicating with Frihet API."""

    def __init__(self, api_key: Optional[str] = None, base_url: str = "https://api.frihet.io/v1") -> None:
        self.api_key = api_key or os.getenv("FRIHET_API_KEY", "")
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Frihet-CrewAI-Toolkit/1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["X-API-Key"] = self.api_key

        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else str(e)
            return {"error": True, "status": e.code, "message": error_body}
        except Exception as e:
            return {"error": True, "message": str(e)}


# ---------------------------------------------------------------------------
# Tool 1: Business Context & High-level Financial KPIs
# ---------------------------------------------------------------------------
class BusinessContextInput(BaseModel):
    include_limits: bool = Field(default=True, description="Whether to include current plan limits and active apps")


class FrihetBusinessContextTool(BaseTool):
    name: str = "frihet_get_business_context"
    description: str = (
        "Retrieve high-level financial health and operating context for the authenticated Frihet company. "
        "Returns unpaid invoice balance, quarterly tax withholdings, currency, and company defaults."
    )
    args_schema: type[BaseModel] = BusinessContextInput
    client: FrihetClientBase = Field(default_factory=FrihetClientBase)

    def _run(self, include_limits: bool = True) -> str:
        res = self.client.request("GET", f"/context?includeLimits={str(include_limits).lower()}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 2: Invoice Management & Receivables Query
# ---------------------------------------------------------------------------
class ListInvoicesInput(BaseModel):
    status: Optional[str] = Field(None, description="Filter by invoice status: 'draft', 'issued', 'paid', or 'overdue'")
    limit: int = Field(default=20, ge=1, le=100, description="Max number of invoices to return")


class FrihetListInvoicesTool(BaseTool):
    name: str = "frihet_list_invoices"
    description: str = (
        "Query invoices from Frihet ERP. Useful for checking pending collections, overdue amounts, "
        "and client billing history. Always read-only."
    )
    args_schema: type[BaseModel] = ListInvoicesInput
    client: FrihetClientBase = Field(default_factory=FrihetClientBase)

    def _run(self, status: Optional[str] = None, limit: int = 20) -> str:
        query = f"?limit={limit}"
        if status:
            query += f"&status={status}"
        res = self.client.request("GET", f"/invoices{query}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 3: Draft Invoice Generation (Human-in-the-Loop Safe)
# ---------------------------------------------------------------------------
class InvoiceItemInput(BaseModel):
    description: str = Field(..., description="Item or service description")
    quantity: float = Field(..., ge=0.01, description="Quantity")
    unitPrice: float = Field(..., ge=0, description="Unit price before tax")
    taxRate: Optional[float] = Field(21.0, description="VAT/IVA percentage (e.g. 21.0, 10.0, 0.0)")


class DraftInvoiceInput(BaseModel):
    clientId: str = Field(..., description="Frihet client ID or tax ID")
    items: List[InvoiceItemInput] = Field(..., description="List of products or services")
    notes: Optional[str] = Field(None, description="Optional notes on the draft invoice")


class FrihetDraftInvoiceTool(BaseTool):
    name: str = "frihet_draft_invoice"
    description: str = (
        "Draft a new customer invoice in Frihet ERP strictly in 'draft' status. "
        "SAFE GUARD: This tool never issues a final fiscal invoice or triggers tax authority reporting. "
        "The generated invoice draft requires human review before dispatch."
    )
    args_schema: type[BaseModel] = DraftInvoiceInput
    client: FrihetClientBase = Field(default_factory=FrihetClientBase)

    def _run(self, clientId: str, items: List[Dict[str, Any]], notes: Optional[str] = None) -> str:
        payload: Dict[str, Any] = {
            "clientId": clientId,
            "status": "draft",  # Immutable safety boundary
            "items": [item if isinstance(item, dict) else item.model_dump() for item in items],
        }
        if notes:
            payload["notes"] = notes

        res = self.client.request("POST", "/invoices", payload=payload)
        return json.dumps(res, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 4: Expense Ledger Query for Accounting Review
# ---------------------------------------------------------------------------
class ListExpensesInput(BaseModel):
    category: Optional[str] = Field(None, description="Expense category filter (e.g. 'software', 'travel', 'office')")
    limit: int = Field(default=25, ge=1, le=100, description="Number of expenses to list")


class FrihetListExpensesTool(BaseTool):
    name: str = "frihet_list_expenses"
    description: str = (
        "Query business expenses from Frihet ERP with deductibility and VAT breakdown. "
        "Ideal for quarterly tax audits, deductibility reviews, and expense auditing."
    )
    args_schema: type[BaseModel] = ListExpensesInput
    client: FrihetClientBase = Field(default_factory=FrihetClientBase)

    def _run(self, category: Optional[str] = None, limit: int = 25) -> str:
        query = f"?limit={limit}"
        if category:
            query += f"&category={category}"
        res = self.client.request("GET", f"/expenses{query}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool 5: Client Search & Directory
# ---------------------------------------------------------------------------
class ListClientsInput(BaseModel):
    query: Optional[str] = Field(None, description="Search term matching client business name, email, or tax ID")
    limit: int = Field(default=20, ge=1, le=100, description="Max records to return")


class FrihetListClientsTool(BaseTool):
    name: str = "frihet_list_clients"
    description: str = "Search the client directory in Frihet ERP to locate client records, tax IDs, and billing contacts."
    args_schema: type[BaseModel] = ListClientsInput
    client: FrihetClientBase = Field(default_factory=FrihetClientBase)

    def _run(self, query: Optional[str] = None, limit: int = 20) -> str:
        params = f"?limit={limit}"
        if query:
            params += f"&q={urllib.parse.quote(query)}"
        res = self.client.request("GET", f"/clients{params}")
        return json.dumps(res, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Unified Toolkit Provider
# ---------------------------------------------------------------------------
class FrihetToolkit:
    """Factory bundling all Frihet tools configured with a single API credential."""

    def __init__(self, api_key: Optional[str] = None, base_url: str = "https://api.frihet.io/v1") -> None:
        self.client = FrihetClientBase(api_key=api_key, base_url=base_url)

    def get_tools(self) -> List[Any]:
        """Return the curated suite of CrewAI-compatible tools."""
        return [
            FrihetBusinessContextTool(client=self.client),
            FrihetListInvoicesTool(client=self.client),
            FrihetDraftInvoiceTool(client=self.client),
            FrihetListExpensesTool(client=self.client),
            FrihetListClientsTool(client=self.client),
        ]
