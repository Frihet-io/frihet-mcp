"""
Official Microsoft AutoGen toolkit for Frihet ERP.
Integrates business intelligence, invoice drafting, and expense analytics into AutoGen agents.
"""

from typing import Dict, Any, List, Optional
import os
import json
import uuid
import urllib.request
import urllib.error
import urllib.parse
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


class FrihetConfig(BaseModel):
    api_key: Optional[str] = None
    base_url: str = "https://api.frihet.io/v1"


class LineItem(BaseModel):
    description: str = Field(description="Description of the good or service")
    quantity: float = Field(gt=0, description="Quantity (must be greater than 0)")
    unit_price: float = Field(ge=0, description="Unit price before tax (must be non-negative)")
    tax_rate: float = Field(default=21.0, ge=0, description="VAT percentage (e.g. 21 for 21%)")


class FrihetClient:
    def __init__(self, config: Optional[FrihetConfig] = None):
        if config is None:
            config = FrihetConfig(
                api_key=os.getenv("FRIHET_API_KEY"),
                base_url=os.getenv("FRIHET_API_BASE_URL", "https://api.frihet.io/v1")
            )
        self.config = config

    def _request(
        self,
        endpoint: str,
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.config.base_url.rstrip('/')}{endpoint}"
        if params:
            filtered_params = {k: v for k, v in params.items() if v is not None}
            if filtered_params:
                url += f"?{urllib.parse.urlencode(filtered_params)}"

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Frihet-AutoGen-Toolkit/1.0.0"
        }
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
            headers["x-frihet-api-key"] = self.config.api_key

        if method in ("POST", "PATCH", "DELETE"):
            headers["Idempotency-Key"] = str(uuid.uuid4())

        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                return redact_sensitive_data(resp_json)
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
    month_str = f"{year:04d}-{month:02d}"
    return _default_client._request("/monthly", params={"month": month_str})


def frihet_get_quarterly_taxes(year: int, quarter: int) -> Dict[str, Any]:
    """Retrieve estimated VAT and income tax withholdings for a quarter (Modelo 303 & 130)."""
    quarter_str = f"{year:04d}-Q{quarter}"
    return _default_client._request("/quarterly", params={"quarter": quarter_str})


def frihet_list_invoices(status: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List customer invoices with status filter (draft, sent, paid, overdue)."""
    return _default_client._request("/invoices", params={"limit": min(limit, 100), "status": status})


def frihet_draft_invoice(client_id: str, items: List[Dict[str, Any]], notes: Optional[str] = None) -> Dict[str, Any]:
    """
    Create a new customer invoice in strictly DRAFT status.
    AI agents cannot legally issue or submit invoices to fiscal authorities; drafts require human review.
    Validates all line items with LineItem Pydantic schema before network dispatch.
    """
    # Strict validation: reject negative quantities or prices before HTTP boundary
    validated_items = [LineItem(**item).model_dump() for item in items]

    payload = {
        "clientId": client_id,
        "items": validated_items,
        "notes": notes,
        "status": "draft",  # Strict draft-only invariant
    }
    return _default_client._request("/invoices", method="POST", data=payload)


def frihet_list_expenses(category: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List recorded business expenses with category filtering."""
    return _default_client._request("/expenses", params={"limit": min(limit, 100), "category": category})


def frihet_list_clients(search: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """List client records and outstanding receivables with URL-safe search."""
    return _default_client._request("/clients", params={"limit": min(limit, 100), "search": search})


def get_frihet_tools() -> List[Any]:
    """Returns the list of Frihet tool functions for AutoGen v0.4+ AssistantAgent."""
    return [
        frihet_get_business_context,
        frihet_get_monthly_summary,
        frihet_get_quarterly_taxes,
        frihet_list_invoices,
        frihet_draft_invoice,
        frihet_list_expenses,
        frihet_list_clients,
    ]


def register_frihet_tools(agent, caller=None) -> List[Any]:
    """
    Helper function to register Frihet tools with AutoGen agents.
    Compatible with AutoGen v0.4+ and legacy v0.2 agent patterns.
    """
    tools = get_frihet_tools()
    for tool in tools:
        if hasattr(agent, "register_for_llm"):
            agent.register_for_llm(description=tool.__doc__)(tool)
        if caller and hasattr(caller, "register_for_execution"):
            caller.register_for_execution()(tool)
    return tools
