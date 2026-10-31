"""
Official Microsoft AutoGen toolkit for Frihet ERP.
Integrates business intelligence, invoice drafting, and expense analytics into AutoGen agents.
"""

from typing import Dict, Any, List, Optional
import os
import json
import urllib.request
import urllib.error
from pydantic import BaseModel, Field


class FrihetConfig(BaseModel):
    api_key: Optional[str] = None
    base_url: str = "https://api.frihet.io/v1"


class LineItem(BaseModel):
    description: str = Field(description="Description of the good or service")
    quantity: float = Field(gt=0, description="Quantity")
    unit_price: float = Field(ge=0, description="Unit price before tax")
    tax_rate: float = Field(default=21.0, ge=0, description="VAT percentage (e.g. 21 for 21%)")


class FrihetClient:
    def __init__(self, config: Optional[FrihetConfig] = None):
        if config is None:
            config = FrihetConfig(
                api_key=os.getenv("FRIHET_API_KEY"),
                base_url=os.getenv("FRIHET_API_BASE_URL", "https://api.frihet.io/v1")
            )
        self.config = config

    def _request(self, endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.config.base_url.rstrip('/')}{endpoint}"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Frihet-AutoGen-Toolkit/1.0.0"
        }
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
            headers["x-frihet-api-key"] = self.config.api_key

        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8")
            return {"error": f"HTTP {e.code}", "detail": error_body}
        except Exception as e:
            return {"error": "ConnectionError", "detail": str(e)}


# Global client instance
_default_client = FrihetClient()


def frihet_get_business_context() -> Dict[str, Any]:
    """Retrieve high-level business profile: operating currency, fiscal country, and company overview."""
    return _default_client._request("/context")


def frihet_get_monthly_summary(year: int, month: int) -> Dict[str, Any]:
    """Retrieve financial summary for a month: revenue, deductible expenses, net margin, and cash."""
    return _default_client._request(f"/summaries/monthly?year={year}&month={month}")


def frihet_get_quarterly_taxes(year: int, quarter: int) -> Dict[str, Any]:
    """Retrieve estimated VAT and income tax withholdings for a quarter."""
    return _default_client._request(f"/summaries/quarterly-taxes?year={year}&quarter={quarter}")


def frihet_list_invoices(status: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List issued customer invoices with status filter (draft, sent, paid, overdue)."""
    endpoint = f"/invoices?limit={min(limit, 100)}"
    if status:
        endpoint += f"&status={status}"
    return _default_client._request(endpoint)


def frihet_draft_invoice(client_id: str, items: List[Dict[str, Any]], notes: Optional[str] = None) -> Dict[str, Any]:
    """
    Create a new customer invoice in DRAFT status.
    AI agents cannot legally issue or submit invoices to fiscal authorities; drafts require human review.
    """
    payload = {
        "clientId": client_id,
        "items": items,
        "notes": notes,
        "status": "draft"  # Strict invariant
    }
    return _default_client._request("/invoices", method="POST", data=payload)


def frihet_list_expenses(category: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List recorded business expenses with category filtering."""
    endpoint = f"/expenses?limit={min(limit, 100)}"
    if category:
        endpoint += f"&category={category}"
    return _default_client._request(endpoint)


def frihet_list_clients(search: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List client records and outstanding receivables."""
    endpoint = f"/clients?limit={min(limit, 100)}"
    if search:
        endpoint += f"&search={search}"
    return _default_client._request(endpoint)


def register_frihet_tools(agent, caller=None):
    """
    Helper function to register Frihet tools with AutoGen agents.
    If caller is provided, registers the functions with caller for execution.
    """
    tools = [
        frihet_get_business_context,
        frihet_get_monthly_summary,
        frihet_get_quarterly_taxes,
        frihet_list_invoices,
        frihet_draft_invoice,
        frihet_list_expenses,
        frihet_list_clients,
    ]
    for tool in tools:
        if hasattr(agent, "register_for_llm"):
            agent.register_for_llm(description=tool.__doc__)(tool)
        if caller and hasattr(caller, "register_for_execution"):
            caller.register_for_execution()(tool)
