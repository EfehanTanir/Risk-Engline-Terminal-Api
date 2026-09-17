# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary
"""Deterministic, unlevered price/FX sensitivity in TRY; no market-data calls."""
import math
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator

router = APIRouter()


class StressAsset(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    type: Literal["stock", "fund"]
    id: str = Field(min_length=1, max_length=20, pattern=r"^\S+$")
    weight: float = Field(ge=0, le=100)
    currency: Literal["TRY", "USD", "EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "HKD"]
    priceShock: float = Field(ge=-100, le=500)


class StressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    assets: list[StressAsset] = Field(min_length=1, max_length=10)
    portfolioValue: float = Field(gt=0, le=1e12)
    fxShocks: dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_portfolio(self):
        keys = [(a.type, a.id.upper()) for a in self.assets]
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate assets")
        if math.fsum(a.weight for a in self.assets) <= 0:
            raise ValueError("Total weight must be positive")
        currencies = {a.currency for a in self.assets} - {"TRY"}
        if set(self.fxShocks) != currencies:
            raise ValueError("Provide one FX shock for every foreign currency, and none for TRY")
        if any(not math.isfinite(v) or not -100 < v <= 500 for v in self.fxShocks.values()):
            raise ValueError("FX shocks must be finite, greater than -100 and at most 500 percent")
        if any(a.type == "fund" and a.currency != "TRY" for a in self.assets):
            raise ValueError("TEFAS fund NAV must be denominated in TRY")
        return self


def calculate(request: StressRequest):
    total = math.fsum(a.weight for a in request.assets)
    rows = []
    for a in request.assets:
        weight = a.weight / total
        initial = request.portfolioValue * weight
        price = a.priceShock / 100
        fx = request.fxShocks.get(a.currency, 0) / 100
        change = (1 + price) * (1 + fx) - 1
        rows.append({"id": a.id, "type": a.type, "currency": a.currency,
                     "weight": weight, "priceShock": a.priceShock, "fxShock": fx * 100,
                     "initialValue": initial, "stressedValue": initial * (1 + change),
                     "returnPct": change * 100, "pnl": initial * change,
                     "pricePnl": initial * price, "fxPnl": initial * fx,
                     "interactionPnl": initial * price * fx})
    pnl = math.fsum(r["pnl"] for r in rows)
    return {"baseCurrency": "TRY", "model": "price-fx-sensitivity-v1",
            "initialValue": request.portfolioValue,
            "stressedValue": request.portfolioValue + pnl,
            "pnl": pnl, "returnPct": pnl / request.portfolioValue * 100,
            "pricePnl": math.fsum(r["pricePnl"] for r in rows),
            "fxPnl": math.fsum(r["fxPnl"] for r in rows),
            "interactionPnl": math.fsum(r["interactionPnl"] for r in rows),
            "assets": rows}


@router.post("/api/stress")
def stress_test(request: StressRequest):
    return calculate(request)
