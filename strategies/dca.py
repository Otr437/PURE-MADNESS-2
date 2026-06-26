"""packages/strategies/dca.py — Dollar Cost Averaging"""
import logging
from datetime import datetime
from typing import Optional, Dict
from .base import TradingStrategy


class DCAStrategy(TradingStrategy):
    name = "DCA Strategy"

    def __init__(self, agent, symbol: str, amount_usd: float, interval_hours: int = 24):
        super().__init__(agent)
        self.symbol = symbol
        self.amount_usd = amount_usd
        self.interval_hours = interval_hours
        self.last_buy_time: Optional[datetime] = None

    def should_buy(self, data: Dict) -> bool:
        if not self.last_buy_time:
            return True
        elapsed = (datetime.now() - self.last_buy_time).total_seconds()
        return elapsed >= self.interval_hours * 3600

    def should_sell(self, data: Dict) -> bool:
        return False

    async def execute(self) -> Optional[str]:
        if self.should_buy({}):
            self.last_buy_time = datetime.now()
            logging.info(f"DCA: Buy ${self.amount_usd} of {self.symbol}")
            return "DCA_EXECUTED"
        return None
