"""packages/strategies/base.py"""
from typing import Optional, Dict


class TradingStrategy:
    name = "Base Strategy"

    def __init__(self, agent):
        self.agent = agent

    def should_buy(self, data: Dict) -> bool:
        raise NotImplementedError

    def should_sell(self, data: Dict) -> bool:
        raise NotImplementedError

    async def execute(self) -> Optional[str]:
        raise NotImplementedError
