"""Integration adapters. Today: CSV/xlsx exports from 1C (CsvSource). Next step of deployment:
1C via the standard OData interface and Bitrix24 REST (see docs/INTEGRATIONS.md for the object mapping).
The engine never depends on the source: any DataSource yields the same six tables."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import pandas as pd

from .replenish import Dataset


class DataSource(Protocol):
    def load(self) -> Dataset: ...


class OrderSink(Protocol):
    def submit_for_approval(self, order: dict[str, Any]) -> str: ...
    def notify(self, text: str) -> None: ...


@dataclass
class CsvSource:
    """Current mode: CSV produced by app.import_partner from the 1C xlsx exports (or hand-made CSV)."""

    folder: Path

    def load(self) -> Dataset:
        return Dataset.load(self.folder)


@dataclass
class OneCODataSource:
    """1C:Enterprise standard OData interface (…/odata/standard.odata/). Mapping in docs/INTEGRATIONS.md.
    Reading: Catalog_Номенклатура, Catalog_Контрагенты, Document_РеализацияТоваровУслуг (+ табличная часть Товары),
    AccumulationRegister_ТоварыНаСкладах/Balance, Document_ЗаказПоставщику. Client ids are hashed on our side."""

    base_url: str
    username: str
    password: str

    ENTITIES = {
        "products": "Catalog_Номенклатура",
        "suppliers": "Catalog_Контрагенты",
        "sales": "Document_РеализацияТоваровУслуг",
        "stock": "AccumulationRegister_ТоварыНаСкладах/Balance",
        "in_transit": "Document_ЗаказПоставщику",
    }

    def load(self) -> Dataset:
        raise NotImplementedError("Подключение к живой базе 1С — следующий этап внедрения; см. docs/INTEGRATIONS.md")

    def push_purchase_order(self, order: dict[str, Any]) -> str:
        """POST Document_ЗаказПоставщику; проведение остаётся за менеджером."""
        raise NotImplementedError


@dataclass
class Bitrix24Sink:
    """Bitrix24 REST: task for approval (tasks.task.add), chat notification (im.notify.system), files (disk.*)."""

    webhook_url: str

    def submit_for_approval(self, order: dict[str, Any]) -> str:
        raise NotImplementedError("tasks.task.add — следующий этап внедрения; см. docs/INTEGRATIONS.md")

    def notify(self, text: str) -> None:
        raise NotImplementedError("im.notify.system — следующий этап внедрения")


def to_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(rows)
